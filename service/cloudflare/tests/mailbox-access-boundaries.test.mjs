import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { mailboxAccessFixture, assertReadOnlyProof } from './mailbox-access-fixture.mjs';
import { newKey } from './runtime-harness.mjs';
let t;
before(async () => { t = await mailboxAccessFixture(); }, { timeout: 90000 });
beforeEach(async () => { await t.h.resetLimits(); t.calls.length = 0; t.modes.clear(); });
after(async () => { await t?.close(); });
const count = table => t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first().then(row => row.n);

test('address alone, extra endpoint fields, invalid keys, missing scope and cross-origin sessions fail before proof', async () => {
  const remote = await t.upstream.create(), input = t.input(remote);
  for (const patch of [{ token: undefined }, { token: '' }, { token: 'not-a-token' }, { address: 'bad' },
    { endpoint: 'https://untrusted.example.test' }, { token: 'a'.repeat(4097) }, { providerId: '../self' }]) {
    const result = await t.recover({ ...input, ...patch }); assert.equal(result.status, 400, result.text);
  }
  assert.equal((await t.recover(input, 'short')).status, 400);
  assert.equal((await t.recover(input, crypto.randomUUID(), { origin: 'https://other.example.test' })).status, 403);
  const key = await newKey(t.h, t.alice.cookie);
  assert.equal((await t.recover(input, crypto.randomUUID(), { cookie: undefined, token: key.token })).status, 403);
  assertReadOnlyProof(t, 0);
});

test('provider catalog never advertises address-only recovery and a legacy endpoint never falls back to create or settings', async () => {
  const catalog = await t.h.request('/api/v1/providers', { cookie: t.alice.cookie });
  assert.equal(catalog.body.items[0].capabilities.restoreByAddress, false);
  assert.equal(catalog.body.items[0].capabilities.credentialRecovery, 'proof-required-v1');
  const remote = await t.upstream.create(); t.modes.set('/api/mailbox_identity', 404);
  const result = await t.recover(t.input(remote)); assert.equal(result.body.error.code, 'mailbox_recovery_unavailable');
  assertReadOnlyProof(t, 1);
});

test('forged credentials, wrong addresses and malformed or incomplete identity contracts never persist a mailbox', async () => {
  const remote = await t.upstream.create(), other = await t.upstream.create(), before = await count('mailboxes');
  for (const input of [{ ...t.input(remote), token: 'e30.e30.ZmFrZQ' }, { ...t.input(remote), address: other.address }]) {
    const result = await t.recover(input); assert.equal(result.status, 502, result.text);
  }
  for (const patch of [{ contract: undefined }, { addressId: '01' }, { expiresAt: undefined }]) {
    t.modes.set('/api/mailbox_identity', { contract: 'easyemail-mailbox-identity-v1', addressId: String(remote.id), address: remote.address, expiresAt: null, ...patch });
    const result = await t.recover(t.input(remote)); assert.equal(result.body.error.code, 'mailbox_proof_invalid');
  }
  assert.equal(await count('mailboxes'), before); assertReadOnlyProof(t, 5);
});

test('cross-user ownership and receipts remain isolated even with a valid upstream token', async () => {
  const remote = await t.upstream.create(), key = crypto.randomUUID(), result = await t.recover(t.input(remote), key);
  assert.equal(result.status, 201, result.text);
  const bob = await t.h.register(`recovery-bob-${crypto.randomUUID()}`);
  const conflict = await t.recover(t.input(remote), crypto.randomUUID(), { cookie: bob.cookie });
  assert.equal(conflict.body.error.code, 'mailbox_address_unavailable'); assert.doesNotMatch(conflict.text, new RegExp(t.alice.id));
  assert.equal((await t.receipt(key, { cookie: bob.cookie })).status, 404);
  assertReadOnlyProof(t, 1);
});

test('expired platform records and all remote mailbox deletion states remain permanent recovery barriers', async () => {
  const remote = await t.upstream.create(), imported = await t.recover(t.input(remote)), id = imported.body.recovery.mailboxId;
  await t.h.db.prepare('UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?').bind(id).run();
  assert.equal((await t.recover(t.input(remote))).body.error.code, 'mailbox_expired');
  await t.h.db.prepare('UPDATE mailboxes SET expires_at=NULL,expired_at=unixepoch() WHERE id=?').bind(id).run();
  assert.equal((await t.recover(t.input(remote))).body.error.code, 'mailbox_expired');
  await t.h.db.prepare('UPDATE mailboxes SET expires_at=NULL,expired_at=NULL WHERE id=?').bind(id).run();
  await t.h.db.prepare(`INSERT INTO remote_mailbox_deletions
    (id,user_id,mailbox_id,provider_id,provider_revision,provider_endpoint,remote_id,address,request_key,request_hash,state,created_at,updated_at)
    VALUES(?,?,?,'self',0,'synthetic',?,?,?,'synthetic','pending',1,1)`)
    .bind(crypto.randomUUID(), t.alice.id, id, String(remote.id), remote.address, crypto.randomUUID()).run();
  for (const state of ['pending', 'unknown', 'deleted', 'absent', 'changed']) {
    await t.h.resetLimits(); await t.h.db.prepare('UPDATE remote_mailbox_deletions SET state=? WHERE mailbox_id=?').bind(state, id).run();
    assert.equal((await t.recover(t.input(remote))).body.error.code, 'remote_mailbox_delete_in_progress');
  }
  assertReadOnlyProof(t, 1);
});

test('an unknown creation address cannot be silently adopted into any owner recovery ledger', async () => {
  const remote = await t.upstream.create(), id = crypto.randomUUID();
  await t.h.db.prepare(`INSERT INTO mailbox_creations(user_id,request_key,request_hash,mailbox_id,address,state,created_at)
    VALUES(?,?,'synthetic',?,?,'unknown',1)`).bind(t.alice.id, crypto.randomUUID(), id, remote.address).run();
  const result = await t.recover(t.input(remote)); assert.equal(result.body.error.code, 'mailbox_recovery_changed_or_limit');
  assert.equal(await t.h.db.prepare('SELECT 1 FROM mailboxes WHERE address=?').bind(remote.address).first(), null);
  assert.equal(await t.h.db.prepare('SELECT 1 FROM mailbox_access_recoveries WHERE address=?').bind(remote.address).first(), null);
  assert.equal((await t.h.db.prepare('SELECT state FROM mailbox_creations WHERE mailbox_id=?').bind(id).first()).state, 'unknown');
});

test('a valid replacement generation never overwrites the original mailbox or cached identity', async () => {
  const remote = await t.upstream.create(), first = await t.recover(t.input(remote)), id = first.body.recovery.mailboxId;
  const before = await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first();
  await t.upstream.db.prepare('DELETE FROM address WHERE id=?').bind(remote.id).run();
  const next = await t.upstream.create(remote.address.split('@')[0]); assert.notEqual(next.id, remote.id);
  assert.equal((await t.recover(t.input(remote))).body.error.code, 'provider_auth_failed');
  assert.equal((await t.recover(t.input(next))).body.error.code, 'mailbox_address_unavailable');
  assert.deepEqual(await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first(), before);
});

test('request digests bind token and exact canonical input without exposing credential material', async () => {
  const remote = await t.upstream.create(), key = crypto.randomUUID(), input = t.input(remote);
  assert.equal((await t.recover(input, key)).status, 201);
  assert.equal((await t.recover({ ...input, token: input.token + 'a' }, key)).body.error.code, 'idempotency_conflict');
  assert.equal((await t.recover({ ...input, address: `other${remote.address}` }, key)).body.error.code, 'idempotency_conflict');
  const ledger = (await t.h.db.prepare('SELECT * FROM mailbox_access_recoveries WHERE request_key=?').bind(key).first());
  assert.match(ledger.request_hash, /^k1\.[0-9a-f]{64}$/); assert.equal(JSON.stringify(ledger).includes(remote.jwt), false);
  const creation = await t.h.db.prepare('SELECT * FROM mailbox_creations WHERE mailbox_id=?').bind(ledger.mailbox_id).first();
  assert.equal(creation.state, 'complete'); assert.equal(JSON.stringify(creation).includes(remote.jwt), false); assertReadOnlyProof(t, 1);
});
