import assert from "node:assert/strict";
import { test } from "node:test";
import { normalRetentionFixture } from "./normal-retention-fixture.mjs";

test("disabled and zero-day policy preserve ordinary cache; trash retention is independent, and live receive claims defer cleanup", async () => {
  const t = await normalRetentionFixture();
  try {
    const { rows: [a, b] } = await t.receive(); await t.age(a.id);
    assert.equal((await t.run()).body.run.counts.purgedNormalMessages, 0);
    await t.policy({ enabled: true, cacheDays: 0, trashDays: 0 });
    assert.equal((await t.preview()).body.preview.counts.purgedNormalMessages, 0);
    await t.h.db.prepare("INSERT INTO normal_message_state(message_id,trashed_at,is_read,starred) VALUES (?,unixepoch()-259200,1,1)").bind(b.id).run();
    await t.policy({ trashDays: 1 });
    const claim = crypto.randomUUID();
    await t.h.db.prepare("UPDATE normal_inbox_state SET claim_token=?,claim_revision=1,claim_lease_until=unixepoch()+90 WHERE account_id=?").bind(claim, t.id).run();
    assert.equal((await t.preview()).body.preview.counts.purgedNormalMessages, 0);
    await t.h.db.prepare("UPDATE normal_inbox_state SET claim_lease_until=unixepoch()-1 WHERE account_id=?").bind(t.id).run();
    assert.equal((await t.run()).body.run.counts.purgedNormalMessages, 1);
    assert.equal((await t.h.db.prepare("SELECT purged_at FROM normal_inbox_messages WHERE id=?").bind(a.id).first()).purged_at, null);
    assert.deepEqual(await t.h.db.prepare("SELECT is_read,starred FROM normal_message_state WHERE message_id=?").bind(b.id).first(), { is_read: 1, starred: 1 });
  } finally { await t.close(); }
});

test("editing reply drafts and live queued, preparing or retryable failed replies pin their original message", async () => {
  const t = await normalRetentionFixture(), { h, alice } = t;
  try {
    const { rows: [source] } = await t.receive(); await t.age(source.id); await t.policy({ enabled: true, cacheDays: 1 });
    const draftId = crypto.randomUUID(), saved = await h.request(`${t.root}/drafts/${draftId}`, { method: "PUT", cookie: alice.cookie,
      body: { expectedRevision: 0, accountRevision: 1, to: ["target@example.test"], subject: "Pinned reply", text: "Reply", replyToMessageId: source.id } });
    assert.equal(saved.status, 201, saved.text); assert.equal((await t.preview()).body.preview.counts.purgedNormalMessages, 0);
    assert.equal((await h.request(`${t.root}/drafts/${draftId}`, { method: "DELETE", cookie: alice.cookie, body: { expectedRevision: 1 } })).status, 200);
    const job = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO normal_send_jobs(id,user_id,account_id,account_revision,smtp_revision,request_key,request_hash,outgoing_key,
      payload_json,due_at,deadline_at,next_attempt_at,state,created_at,updated_at) VALUES (?,?,?,1,1,?,?,?, ?,unixepoch(),unixepoch()+1000,unixepoch(),'queued',unixepoch(),unixepoch())`)
      .bind(job, alice.id, t.id, crypto.randomUUID(), "synthetic-hash", `queue:${job}`, JSON.stringify({ reply: source.id })).run();
    for (const state of ["queued", "preparing", "failed"]) {
      await h.db.prepare("UPDATE normal_send_jobs SET state=? WHERE id=?").bind(state, job).run();
      assert.equal((await t.preview()).body.preview.counts.purgedNormalMessages, 0, state);
    }
    await h.db.prepare("UPDATE normal_send_jobs SET state='cancelled' WHERE id=?").bind(job).run();
    const outgoing = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO normal_outgoing_messages(id,user_id,account_id,account_revision,smtp_revision,endpoint_hash,request_key,request_hash,
      from_address,to_address,recipient_count,subject,text_body,state,created_at,updated_at,reply_message_id,reply_threading)
      VALUES (?,?,?,1,1,'synthetic-endpoint',?,'synthetic-hash','alice@example.test','to@example.test',1,'Pending reply','Reply','pending',unixepoch(),unixepoch(),?,'submitted')`)
      .bind(outgoing, alice.id, t.id, crypto.randomUUID(), source.id).run();
    assert.equal((await t.preview()).body.preview.counts.purgedNormalMessages, 0, "pending outgoing pins its source");
    await h.db.prepare("UPDATE normal_outgoing_messages SET state='unknown' WHERE id=?").bind(outgoing).run();
    assert.equal((await t.run()).body.run.counts.purgedNormalMessages, 1);
    const reply = await h.request(`${t.root}/messages/${source.id}/reply`, { cookie: alice.cookie }); assert.equal(reply.status, 404);
    const again = await h.request(`${t.root}/messages/organize`, { cookie: alice.cookie, method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [source.id], isRead: true } });
    assert.equal(again.status, 409, again.text);
  } finally { await t.close(); }
});

test("superseded epochs and soft-deleted accounts release aged content without resetting source identity or touching foreign objects", async () => {
  const t = await normalRetentionFixture();
  try {
    const first = await t.receive(), bucket = await t.h.bucket("INBOX");
    for (const row of first.rows) await t.age(row.id);
    t.scenario({ validity: "43" }); const second = await t.receive();
    await t.policy({ enabled: true, cacheDays: 1 });
    await bucket.put("normal-inbox/v1/foreign/object.eml", "must remain");
    assert.equal((await t.run()).body.run.counts.purgedNormalMessages, 2);
    const current = await t.state(); assert.equal(current.epoch_id, second.result.result.epochId);
    for (const row of second.rows.filter(x => x.epoch_id === current.epoch_id)) await t.age(row.id);
    assert.equal((await t.h.request(t.root, { cookie: t.alice.cookie, method: "DELETE", headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } })).status, 200);
    assert.equal((await t.run()).body.run.counts.purgedNormalMessages, 2);
    assert.equal((await t.state()).epoch_id, current.epoch_id); assert.ok(await bucket.head("normal-inbox/v1/foreign/object.eml"));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_requests").first("n"), 2);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
