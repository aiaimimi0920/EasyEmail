import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailboxAccessFixture } from './mailbox-access-fixture.mjs';

test('failed import batches leave no complete receipt, creation guard or mailbox, and same-key retry is safe', async () => {
  const t = await mailboxAccessFixture();
  try {
    const remote = await t.upstream.create(), key = crypto.randomUUID(), input = t.input(remote);
    for (const table of ['mailbox_creations', 'mailboxes']) {
      await t.h.db.prepare(`CREATE TRIGGER fail_recovery BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`).run();
      const result = await t.recover(input, key); assert.equal(result.body.error.code, 'mailbox_recovery_storage_unconfirmed');
      for (const name of ['mailbox_access_recoveries', 'mailbox_creations', 'mailboxes']) {
        assert.equal((await t.h.db.prepare(`SELECT COUNT(*) n FROM ${name}`).first()).n, 0, name);
      }
      assert.equal((await t.receipt(key)).status, 404);
      await t.h.db.prepare('DROP TRIGGER fail_recovery').run();
    }
    assert.equal((await t.recover(input, key)).status, 201);
    assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailbox_access_recoveries').first()).n, 1);
  } finally { await t.close(); }
});

test('failed restore keeps released credentials retired and old receipts intact', async () => {
  const t = await mailboxAccessFixture();
  try {
    const remote = await t.upstream.create(), imported = await t.recover(t.input(remote)), id = imported.body.recovery.mailboxId;
    await t.h.request(`/api/v1/mailboxes/${id}/lifecycle`, { method: 'POST', cookie: t.alice.cookie, body: { action: 'release', confirmAddress: remote.address } });
    const before = await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first();
    await t.h.db.prepare(`CREATE TRIGGER fail_restore BEFORE UPDATE ON mailboxes BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`).run();
    const key = crypto.randomUUID(), result = await t.recover(t.input(remote), key);
    assert.equal(result.body.error.code, 'mailbox_recovery_storage_unconfirmed'); assert.equal((await t.receipt(key)).status, 404);
    assert.deepEqual(await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first(), before);
    await t.h.db.prepare('DROP TRIGGER fail_restore').run();
    assert.equal((await t.recover(t.input(remote), key)).body.recovery.mode, 'restored');
  } finally { await t.close(); }
});

test('0059 is expand-only and missing recovery schema rejects before upstream access', async () => {
  const t = await mailboxAccessFixture(false, '0058_normal_remote_mutations.sql');
  try {
    const remote = await t.upstream.create();
    const before = (await t.h.db.prepare('SELECT * FROM users').all()).results;
    assert.equal((await t.recover(t.input(remote))).body.error.code, 'mailbox_recovery_schema_required'); assert.equal(t.calls.length, 0);
    await t.h.migrate(); assert.deepEqual((await t.h.db.prepare('SELECT * FROM users').all()).results, before);
    assert.equal((await t.recover(t.input(remote))).status, 201);
  } finally { await t.close(); }
});

test('imports honor permanent creation and legacy mailbox quotas; recovery ledgers are bounded without blocking old-key reads', async () => {
  const t = await mailboxAccessFixture();
  try {
    const remote = await t.upstream.create(), key = crypto.randomUUID(), initial = await t.recover(t.input(remote), key), id = initial.body.recovery.mailboxId;
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<99)
      INSERT INTO mailbox_creations(user_id,request_key,request_hash,mailbox_id,address,state,created_at)
      SELECT ?,'quota-'||i,'synthetic','quota-box-'||i,'quota-'||i||'@example.test','unknown',1 FROM n`).bind(t.alice.id).run();
    const next = await t.upstream.create();
    assert.equal((await t.recover(t.input(next))).body.error.code, 'mailbox_recovery_changed_or_limit');
    assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailboxes WHERE user_id=?').bind(t.alice.id).first()).n, 1);
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<999)
      INSERT INTO mailbox_access_recoveries(id,user_id,request_key,request_hash,mailbox_id,provider_id,address,mode,created_at)
      SELECT 'quota-receipt-'||i,?,'quota-request-'||i,'synthetic',?,'self',?,'refreshed',1 FROM n`).bind(t.alice.id, id, remote.address).run();
    assert.equal((await t.recover(t.input(remote))).body.error.code, 'mailbox_recovery_changed_or_limit');
    assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailbox_access_recoveries').first()).n, 1000);
    assert.deepEqual((await t.recover(t.input(remote), key)).body, initial.body); assert.deepEqual((await t.receipt(key)).body, initial.body);
    const bob = await t.h.register(`legacy-quota-${crypto.randomUUID()}`);
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100)
      INSERT INTO mailboxes(id,user_id,provider_id,remote_id,address,status,created_at)
      SELECT 'legacy-quota-'||i,?,'synthetic-fixture','legacy-quota-'||i,'legacy-quota-'||i||'@example.test','active',1 FROM n`).bind(bob.id).run();
    assert.equal((await t.recover(t.input(next), crypto.randomUUID(), { cookie: bob.cookie })).body.error.code, 'mailbox_recovery_changed_or_limit');
    assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailboxes WHERE user_id=?').bind(bob.id).first()).n, 100);
  } finally { await t.close(); }
});
