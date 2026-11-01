import assert from "node:assert/strict";
import { test } from "node:test";
import PostalMime from "postal-mime";
import { normalQueueFixture } from "./normal-queue-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { assetBytes, assetRef } from "./outbox-fixture.mjs";

test("ordinary queued draft is durably consumed, pins attachments and sends once through the real SMTP serializer", async () => {
  const t = await normalQueueFixture();
  try {
    await t.configure(); const asset = await t.upload(), attachments = [assetRef(asset)], draft = crypto.randomUUID();
    assert.equal((await t.save(draft, attachments)).status, 201);
    const body = { ...mailInput, attachments, draftId: draft, draftRevision: 1 }, key = crypto.randomUUID();
    const queued = await t.enqueue(body, key); assert.equal(queued.status, 201, queued.text); const job = queued.body.job;
    assert.equal(job.accountId, t.id); assert.equal(job.accountRevision, 1); assert.equal(job.smtpRevision, 1); assert.equal(job.state, "queued"); assert.equal(t.opens.length, 0);
    assert.equal((await t.enqueue(body, key)).body.job.id, job.id); assert.equal((await t.enqueue({ ...body, text: "changed" }, key)).status, 409);
    assert.equal((await t.h.request(`${t.path}/drafts/${draft}`, { cookie: t.alice.cookie })).body.draft.state, "submitted");
    assert.equal((await t.remove(asset.id)).body.error.code, "outbox_attachment_in_use");
    await t.h.restart(); await t.tick(); const done = await t.get(job.id); assert.equal(done.body.job.state, "accepted", done.text);
    assert.equal(done.body.job.cancellable, false); assert.equal(done.body.job.retrySafe, false); assert.ok(done.body.job.outgoingId);
    const parsed = await PostalMime.parse(t.messages[0].replace(/\r\n\.\r\n$/, "\r\n")); assert.deepEqual(Buffer.from(parsed.attachments[0].content), Buffer.from(assetBytes));
    await t.tick(); assert.equal(t.messages.length, 1); assert.equal((await t.enqueue(body, key)).body.job.outgoingId, done.body.job.outgoingId);
    assert.equal((await t.remove(asset.id)).status, 200); assert.equal((await t.action(done.body.job, "retry")).status, 409);
  } finally { await t.close(); }
});

test("ordinary scheduled queue survives restart, does not send early and cancellation never restores a consumed draft", async () => {
  const t = await normalQueueFixture();
  try {
    await t.configure(); const draft = crypto.randomUUID(); assert.equal((await t.save(draft, [])).status, 201);
    const body = { ...mailInput, draftId: draft, draftRevision: 1, scheduledAt: Math.floor(Date.now() / 1000) + 600 };
    const created = await t.enqueue(body); assert.equal(created.status, 201, created.text); const job = created.body.job;
    await t.h.restart(); await t.tick(); assert.equal(t.opens.length, 0);
    const key = crypto.randomUUID(), cancelled = await t.action(job, "cancel", key); assert.equal(cancelled.body.job.state, "cancelled", cancelled.text);
    assert.equal((await t.action(job, "cancel", key)).body.job.state, "cancelled");
    await t.tick(); assert.equal(t.opens.length, 0); assert.equal((await t.h.request(`${t.path}/drafts/${draft}`, { cookie: t.alice.cookie })).body.draft.state, "submitted");
    assert.equal((await t.h.request("/api/v1/send-jobs", { cookie: t.alice.cookie })).body.items.length, 0);
    assert.equal((await t.h.request(`/api/v1/send-jobs/${job.id}`, { cookie: t.alice.cookie })).status, 404);
  } finally { await t.close(); }
});
test("ordinary queue retention clears terminal content but keeps retryable or pending content and permanent intent/action guards", async () => {
  const t = await normalQueueFixture();
  try {
    await t.configure(); const a = await t.upload(), body = { ...mailInput, attachments: [assetRef(a)] };
    const cancelled = (await t.enqueue(body)).body.job, cancelKey = crypto.randomUUID(); await t.action(cancelled, "cancel", cancelKey);
    const expired = (await t.enqueue(body)).body.job, retryable = (await t.enqueue(body)).body.job;
    await t.h.db.prepare("UPDATE normal_send_jobs SET state='failed',deadline_at=1 WHERE id=?").bind(expired.id).run();
    await t.h.db.prepare("UPDATE normal_send_jobs SET state='failed' WHERE id=?").bind(retryable.id).run();
    const pending = (await t.enqueue(body)).body.job; await t.h.restart({ TEST_QUEUE_FAULT: "guard-receipt-lost" }); await t.tick();
    await t.h.restart({ TEST_QUEUE_FAULT: "" }); const sent = (await t.enqueue(body)).body.job; await t.tick(); assert.equal(t.messages.length, 1);
    await t.h.db.exec("UPDATE normal_send_jobs SET updated_at=1; UPDATE normal_outgoing_messages SET updated_at=1; UPDATE retention_policy SET enabled=1,outgoing_days=1,revision=revision+1;");
    await t.h.scheduled();
    for (const job of [cancelled, expired, sent]) {
      const row = await t.h.db.prepare("SELECT * FROM normal_send_jobs WHERE id=?").bind(job.id).first();
      assert.equal(row.payload_json, null); assert.equal(row.attachments_json, null); assert.ok(row.content_purged_at); assert.ok(row.request_hash); assert.ok(row.outgoing_key);
    }
    for (const job of [retryable, pending]) assert.ok(await t.h.db.prepare("SELECT payload_json FROM normal_send_jobs WHERE id=?").bind(job.id).first("payload_json"));
    assert.equal((await t.action(cancelled, "cancel", cancelKey)).body.job.state, "cancelled");
    assert.equal((await t.enqueue(body, sent.requestKey)).body.job.state, "accepted");
    await t.h.restart(); await t.tick(); assert.equal(t.messages.length, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_send_job_operations").first("n"), 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 2);
  } finally { await t.close(); }
});
test("ordinary draft consumption failure rolls back the intent and allows only the same successful intent to consume once", async () => {
  const t = await normalQueueFixture();
  try {
    await t.configure(); const draft = crypto.randomUUID(), key = crypto.randomUUID(); await t.save(draft, []);
    const body = { ...mailInput, draftId: draft, draftRevision: 1 };
    await t.h.db.exec("CREATE TRIGGER normal_queue_draft_failure BEFORE UPDATE ON drafts WHEN NEW.state='submitted' BEGIN SELECT RAISE(ABORT,'synthetic consume failure'); END");
    assert.equal((await t.enqueue(body, key)).status, 500);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_send_jobs").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT state FROM drafts WHERE id=?").bind(draft).first("state"), "editing");
    await t.h.db.exec("DROP TRIGGER normal_queue_draft_failure"); assert.equal((await t.enqueue(body, key)).status, 201);
    assert.equal((await t.send(body)).body.error.code, "draft_submitted"); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
