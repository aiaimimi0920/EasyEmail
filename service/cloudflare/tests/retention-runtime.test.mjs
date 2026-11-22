import assert from "node:assert/strict";
import { test } from "node:test";
import { ok } from "./admin-fixture.mjs";
import { allocate, cfMail } from "./provider-fixture.mjs";
import { retentionFixture, seedRetentionMessage } from "./retention-fixture.mjs";
import { sendCalls, sendRequest } from "./send-fixture.mjs";

test("preview is non-mutating; retention clears eligible content and credentials, not identities, hashes, quotas or replay guards", async () => {
  const a = await retentionFixture(), { h, f, alice, admin } = a;
  try {
    const box = ok(await allocate(h, alice.cookie), 201).mailbox;
    f.messages.set(box.address, [cfMail(box.address, 1)]);
    ok(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }));
    const message = await h.db.prepare("SELECT * FROM messages LIMIT 1").first();
    const sealed = (await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(box.id).first()).credential_cipher;
    await h.db.prepare("UPDATE messages SET observed_at=unixepoch()-259200 WHERE id=?").bind(message.id).run();
    const fresh = await seedRetentionMessage(h, alice.id, box, { age: 0 });
    const key = crypto.randomUUID(); f.modes.set("/cf/admin/send_mail_by_binding", "disconnect");
    assert.equal((await sendRequest(h, alice.cookie, box, key)).body.outgoing.state, "unknown"); f.modes.clear();
    await h.db.prepare("UPDATE outgoing_messages SET created_at=unixepoch()-259200,updated_at=unixepoch()-172800").run();
    const outgoing = await h.db.prepare("SELECT * FROM outgoing_messages LIMIT 1").first();
    await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run();
    await h.db.prepare("INSERT INTO admin_audit(id,actor_id,provider_id,action,revision,created_at) VALUES (?,?,'self','probe',0,unixepoch()-259200)")
      .bind(crypto.randomUUID(), admin.id).run();
    ok(await a.policy({ enabled: true, cacheDays: 1, outgoingDays: 1, auditDays: 1 }));
    const calls = f.calls.length, preview = ok(await a.preview()).preview;
    assert.deepEqual(preview.counts, { expiredMailboxes: 1, purgedMessages: 1, redactedOutgoing: 1, prunedAudit: 1, purgedNormalMessages: 0, retiredNormalBatches: 0 });
    assert.equal((await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(message.id).first()).purged_at, null);
    const result = ok(await a.run()).run;
    assert.deepEqual(result.counts, preview.counts); assert.equal(result.upstreamChanged, false); assert.equal(f.calls.length, calls);
    const purged = await h.db.prepare("SELECT * FROM messages WHERE id=?").bind(message.id).first();
    for (const field of ["sender", "recipient", "subject", "text_body", "html_body"]) assert.equal(purged[field], "");
    assert.equal(purged.attachments, "[]"); assert.equal(purged.rfc_message_id, null); assert.equal(purged.fingerprint, message.fingerprint);
    assert.equal((await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(fresh).first()).purged_at, null);
    const after = await h.db.prepare("SELECT * FROM outgoing_messages LIMIT 1").first();
    for (const field of ["id", "request_key", "request_hash", "state", "created_at", "updated_at", "mailbox_id"]) assert.equal(after[field], outgoing[field]);
    for (const field of ["from_address", "to_address", "subject", "text_body"]) assert.equal(after[field], "");
    assert.ok(after.content_purged_at);
    const replay = await sendRequest(h, alice.cookie, box, key);
    assert.equal(replay.body.outgoing.state, "unknown"); assert.ok(replay.body.outgoing.contentPurgedAt); assert.equal(sendCalls(f).length, 1);
    const expired = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(box.id).first();
    assert.ok(expired.expired_at); assert.equal(expired.credential_cipher, null); assert.equal(expired.released_at, null);
    // Restore only the synthetic fixture to exercise a new valid lease against an existing upstream JWT.
    await h.db.prepare("UPDATE mailboxes SET expired_at=NULL,expires_at=NULL,credential_cipher=? WHERE id=?")
      .bind(sealed, box.id).run();
    assert.equal(ok(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} })).sync.inserted, 0);
    assert.equal((await h.db.prepare("SELECT text_body FROM messages WHERE id=?").bind(message.id).first()).text_body, "");
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 1);
    await h.restart(); assert.ok((await a.retention()).lastRun);
  } finally { await a.close(); }
});

test("same manual key has one atomic bounded batch; new keys and new scheduled windows continue the backlog", async () => {
  const a = await retentionFixture(), { h, alice } = a;
  try {
    const box = ok(await allocate(h, alice.cookie), 201).mailbox;
    for (let i = 0; i < 105; i++) await seedRetentionMessage(h, alice.id, box);
    ok(await a.policy({ enabled: true, cacheDays: 1 }));
    const preview = ok(await a.preview()).preview;
    assert.equal(preview.counts.purgedMessages, 100); assert.equal(preview.more.purgedMessages, true);
    const key = crypto.randomUUID(), revision = (await a.retention()).revision;
    const results = await Promise.all([a.run(key, revision), a.run(key, revision)]);
    for (const result of results) { ok(result); assert.equal(result.body.run.counts.purgedMessages, 100); }
    assert.equal(results.filter((row) => row.body.replayed).length, 1);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE purged_at IS NOT NULL").first()).n, 100);
    assert.equal(ok(await a.run(key, revision)).replayed, true);
    assert.equal(ok(await a.run()).run.counts.purgedMessages, 5);
    assert.equal(ok(await a.run()).run.counts.purgedMessages, 0);
    await h.resetLimits(); await seedRetentionMessage(h, alice.id, box);
    const scheduledTime = Date.parse("2026-10-28T01:00:00Z");
    await h.scheduled(scheduledTime);
    const count = (await h.db.prepare("SELECT COUNT(*) n FROM retention_runs WHERE trigger_kind='scheduled'").first()).n;
    await seedRetentionMessage(h, alice.id, box); await h.scheduled(scheduledTime);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM retention_runs WHERE trigger_kind='scheduled'").first()).n, count);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE purged_at IS NULL").first()).n, 1);
    await h.scheduled(scheduledTime + 900000);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE purged_at IS NULL").first()).n, 0);
  } finally { await a.close(); }
});
