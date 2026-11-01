import assert from "node:assert/strict";
import { test } from "node:test";
import { ok } from "./admin-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";
import { retentionFixture, seedRetentionMessage } from "./retention-fixture.mjs";
import { sendRequest } from "./send-fixture.mjs";

test("a late maintenance failure rolls back every earlier mutation and the run guard; the same key can then complete", async () => {
  const a = await retentionFixture(), { h, alice, admin } = a;
  try {
    const box = ok(await allocate(h, alice.cookie), 201).mailbox;
    const message = await seedRetentionMessage(h, alice.id, box);
    ok(await sendRequest(h, alice.cookie, box, crypto.randomUUID()), 201);
    await h.db.prepare("UPDATE outgoing_messages SET updated_at=unixepoch()-259200").run();
    await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run();
    await h.db.prepare("INSERT INTO admin_audit(id,actor_id,provider_id,action,revision,created_at) VALUES (?,?,'self','probe',0,unixepoch()-259200)")
      .bind(crypto.randomUUID(), admin.id).run();
    ok(await a.policy({ enabled: true, cacheDays: 1, outgoingDays: 1, auditDays: 1 }));
    const before = {};
    for (const table of ["mailboxes", "messages", "outgoing_messages", "admin_audit", "retention_runs"]) {
      before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    }
    const key = crypto.randomUUID();
    await h.db.prepare("CREATE TRIGGER fail_retention_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END").run();
    try { assert.equal((await a.run(key)).body.error.code, "retention_storage_failed"); }
    finally { await h.db.prepare("DROP TRIGGER fail_retention_delete").run(); }
    for (const [table, rows] of Object.entries(before)) assert.deepEqual((await h.db.prepare(`SELECT * FROM ${table}`).all()).results, rows, table);
    const completed = ok(await a.run(key));
    assert.equal(completed.replayed, false);
    assert.deepEqual(completed.run.counts, { expiredMailboxes: 1, purgedMessages: 1, redactedOutgoing: 1, prunedAudit: 1, purgedNormalMessages: 0, retiredNormalBatches: 0 });
    assert.ok((await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(message).first()).purged_at);
    ok(await a.policy({ cacheDays: 2 }));
    assert.equal((await a.run(key)).body.error.code, "idempotency_conflict");
  } finally { await a.close(); }
});

test("default-off preserves old content; restored trash and pending sends are excluded; missing policy fails closed", async () => {
  const a = await retentionFixture(), { h, alice } = a;
  try {
    const box = ok(await allocate(h, alice.cookie), 201).mailbox;
    await seedRetentionMessage(h, alice.id, box);
    const trash = await seedRetentionMessage(h, alice.id, box, { age: 0, trash: 3 });
    const restored = await seedRetentionMessage(h, alice.id, box, { age: 0, trash: 3 });
    ok(await h.request(`/api/v1/mailboxes/${box.id}/messages/${restored}/restore`, { cookie: alice.cookie, method: "POST", body: {} }));
    assert.deepEqual(ok(await a.preview()).preview.counts, { expiredMailboxes: 0, purgedMessages: 0, redactedOutgoing: 0, prunedAudit: 0, purgedNormalMessages: 0, retiredNormalBatches: 0 });
    assert.equal(ok(await a.run()).run.counts.purgedMessages, 0);
    ok(await sendRequest(h, alice.cookie, box, crypto.randomUUID()), 201);
    await h.db.prepare("UPDATE outgoing_messages SET state='pending',updated_at=unixepoch()-259200").run();
    ok(await a.policy({ enabled: true, trashDays: 1, outgoingDays: 1 }));
    assert.equal(ok(await a.preview()).preview.counts.purgedMessages, 1);
    const run = ok(await a.run()).run;
    assert.equal(run.counts.purgedMessages, 1); assert.equal(run.counts.redactedOutgoing, 0);
    assert.ok((await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(trash).first()).purged_at);
    assert.equal((await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(restored).first()).purged_at, null);
    await h.db.prepare("DELETE FROM retention_policy WHERE id=1").run();
    const calls = a.f.calls.length;
    assert.equal((await allocate(h, alice.cookie)).body.error.code, "retention_policy_unavailable");
    assert.equal((await h.request("/api/v1/admin/retention", { cookie: a.admin.cookie })).status, 503);
    assert.equal(a.f.calls.length, calls);
  } finally { await a.close(); }
});
