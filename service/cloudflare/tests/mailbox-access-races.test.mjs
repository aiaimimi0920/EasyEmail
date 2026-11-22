import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { mailboxAccessFixture } from './mailbox-access-fixture.mjs';
import { newKey } from './runtime-harness.mjs';
import { createHmac } from 'node:crypto';
let t;
before(async () => { t = await mailboxAccessFixture(); }, { timeout: 90000 });
beforeEach(async () => { await t.h.resetLimits(); t.calls.length = 0; });
after(async () => { await t?.close(); });

test('same-key concurrent recovery has one batch winner and one exact mailbox revision', async () => {
  const remote = await t.upstream.create(), input = t.input(remote), key = crypto.randomUUID();
  const gate = t.hold(), pending = t.recover(input, key); let first, second;
  try { await gate.entered; second = await t.recover(input, key); }
  finally { gate.release(); first = await pending; }
  assert.equal(second.status, 201, second.text); assert.deepEqual(first.body, second.body);
  assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailbox_access_recoveries WHERE request_key=?').bind(key).first()).n, 1);
  const stored = await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(first.body.recovery.mailboxId).first();
  assert.equal(stored.sync_revision, 0);
});

test('different owners racing with the same valid proof never transfer an occupied address', async () => {
  const remote = await t.upstream.create(), input = t.input(remote), bob = await t.h.register(`race-owner-${crypto.randomUUID()}`);
  const gate = t.hold(), pending = t.recover(input); let loser, winner;
  try { await gate.entered; winner = await t.recover(input, crypto.randomUUID(), { cookie: bob.cookie }); }
  finally { gate.release(); loser = await pending; }
  assert.equal(winner.status, 201, winner.text); assert.equal(loser.body.error.code, 'mailbox_recovery_changed_or_limit');
  const row = await t.h.db.prepare('SELECT user_id FROM mailboxes WHERE address=?').bind(remote.address).first(); assert.equal(row.user_id, bob.id);
  assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailbox_creations WHERE address=?').bind(remote.address).first()).n, 1);
});

test('release or disable while live proof is in flight fences the late credential update', async () => {
  const remote = await t.upstream.create(), input = t.input(remote), result = await t.recover(input), id = result.body.recovery.mailboxId;
  for (const action of ['disable', 'release']) {
    const gate = t.hold(), key = crypto.randomUUID(), pending = t.recover(input, key); let outcome, saved;
    try {
      await gate.entered;
      const transition = await t.h.request(`/api/v1/mailboxes/${id}/lifecycle`, { method: 'POST', cookie: t.alice.cookie,
        body: { action, ...(action === 'release' ? { confirmAddress: remote.address } : {}) } });
      assert.equal(transition.status, 200, transition.text);
      saved = await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first();
    } finally { gate.release(); outcome = await pending; }
    assert.equal(outcome.body.error.code, 'mailbox_recovery_changed_or_limit'); assert.equal((await t.receipt(key)).status, 404);
    assert.deepEqual(await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first(), saved);
  }
});

test('revoked API key, narrowed write scope and disabled principal cannot commit after proof begins', async () => {
  for (const change of ['scope', 'revoked', 'user']) {
    await t.h.resetLimits();
    const caller = await t.h.register(`race-caller-${crypto.randomUUID()}`), key = await newKey(t.h, caller.cookie, { scopes: ['mailboxes:write'] });
    const remote = await t.upstream.create(), requestKey = crypto.randomUUID(), gate = t.hold();
    const pending = t.recover(t.input(remote), requestKey, { cookie: undefined, token: key.token }); let result;
    try {
      await gate.entered;
      const sql = change === 'scope' ? "UPDATE api_keys SET scopes='[]' WHERE user_id=?"
        : change === 'revoked' ? 'UPDATE api_keys SET revoked_at=unixepoch() WHERE user_id=?' : "UPDATE users SET status='disabled' WHERE id=?";
      await t.h.db.prepare(sql).bind(caller.id).run();
    } finally { gate.release(); result = await pending; }
    assert.equal(result.body.error.code, 'mailbox_recovery_changed_or_limit');
    assert.equal(await t.h.db.prepare('SELECT 1 FROM mailboxes WHERE address=?').bind(remote.address).first(), null);
    assert.equal(await t.h.db.prepare('SELECT 1 FROM mailbox_access_recoveries WHERE request_key=?').bind(requestKey).first(), null);
  }
});

test('provider revision and expiry transitions during proof cannot be overwritten', async () => {
  const remote = await t.upstream.create(), input = t.input(remote), initial = await t.recover(input), id = initial.body.recovery.mailboxId;
  for (const change of ['provider', 'expiry', 'tombstone']) {
    await t.h.resetLimits(); const gate = t.hold(), pending = t.recover(input); let result;
    try {
      await gate.entered;
      if (change === 'provider') {
        const config = { id: 'self', type: 'cloudflare', baseUrl: `http://127.0.0.1:${new URL(t.h.baseUrl).port}`, domains: ['cf.example.test'] };
        await t.h.db.prepare("INSERT INTO provider_overrides(id,config_json,revision,secret_source,change_token,updated_at) VALUES('self',?,1,'environment',?,unixepoch())")
          .bind(JSON.stringify(config), crypto.randomUUID()).run();
      } else await t.h.db.prepare(`UPDATE mailboxes SET ${change === 'expiry' ? 'expires_at=unixepoch()-1' : 'expired_at=unixepoch()'} WHERE id=?`).bind(id).run();
    } finally { gate.release(); result = await pending; }
    assert.equal(result.body.error.code, 'mailbox_recovery_changed_or_limit');
    if (change === 'provider') await t.h.db.prepare("DELETE FROM provider_overrides WHERE id='self'").run();
    else await t.h.db.prepare('UPDATE mailboxes SET expires_at=NULL,expired_at=NULL WHERE id=?').bind(id).run();
  }
});

test('short-lived replacement credentials preserve original platform expiry and expiry proof must still be live', async () => {
  const remote = await t.upstream.create(), input = t.input(remote), initial = await t.recover(input), id = initial.body.recovery.mailboxId;
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  await t.h.db.prepare('UPDATE mailboxes SET expires_at=? WHERE id=?').bind(expiry, id).run();
  const token = exp => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ address: remote.address, address_id: remote.id, exp })).toString('base64url');
    return `${header}.${payload}.${createHmac('sha256', 'synthetic-upstream-jwt-secret-32bytes-minimum').update(`${header}.${payload}`).digest('base64url')}`;
  };
  const result = await t.recover({ ...input, token: token(Math.floor(Date.now() / 1000) + 300) });
  assert.equal(result.status, 200, result.text); assert.equal(result.body.recovery.mode, 'refreshed');
  assert.equal((await t.h.db.prepare('SELECT expires_at FROM mailboxes WHERE id=?').bind(id).first()).expires_at, expiry);
  assert.equal((await t.recover({ ...input, token: token(Math.floor(Date.now() / 1000) - 1) })).body.error.code, 'provider_auth_failed');
});

test('an unresolved send appearing during proof blocks credential replacement in the final batch', async () => {
  const remote = await t.upstream.create(), input = t.input(remote), initial = await t.recover(input), id = initial.body.recovery.mailboxId;
  const before = await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first();
  const gate = t.hold(), pending = t.recover(input); let result;
  try {
    await gate.entered;
    await t.h.db.prepare(`INSERT INTO outgoing_messages
      (id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,from_address,to_address,subject,text_body,threading,state,created_at,updated_at)
      VALUES(?,?,?,?,'synthetic','self','binding',?,'recipient@example.test','synthetic','never sent','none','unknown',1,1)`)
      .bind(crypto.randomUUID(), t.alice.id, id, crypto.randomUUID(), remote.address).run();
  } finally { gate.release(); result = await pending; }
  assert.equal(result.body.error.code, 'mailbox_recovery_changed_or_limit');
  assert.deepEqual(await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first(), before);
});
