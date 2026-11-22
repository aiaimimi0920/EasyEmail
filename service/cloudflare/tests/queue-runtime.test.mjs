import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { outboxFixture } from "./outbox-fixture.mjs";
import { sendBody, sendCalls } from "./send-fixture.mjs";

let fixture, h, f, alice, box;
const enqueue = (key = crypto.randomUUID(), body = sendBody, extra = {}) => h.request(`/api/v1/mailboxes/${box.id}/send-jobs`, {
  method: "POST", cookie: alice.cookie, headers: { "idempotency-key": key }, body, ...extra,
});
before(async () => { fixture = await outboxFixture(); ({ h, f, alice, box } = fixture); });
beforeEach(async () => {
  await h.resetLimits(); await h.db.prepare("DELETE FROM send_job_operations").run();
  await h.db.prepare("DELETE FROM send_jobs").run(); await h.db.prepare("DELETE FROM outgoing_messages").run();
});
after(async () => { await fixture?.close(); });

test("enqueue is a durable intent, not a send; restart and duplicate cron dispatch at most once", async () => {
  const key = crypto.randomUUID(), count = sendCalls(f).length;
  const result = await enqueue(key);
  assert.equal(result.status, 201, result.text); assert.equal(result.body.job.state, "queued");
  assert.equal(sendCalls(f).length, count);
  await h.restart();
  assert.equal((await enqueue(key)).body.job.id, result.body.job.id);
  await Promise.all([h.scheduled(Date.now(), "* * * * *"), h.scheduled(Date.now(), "* * * * *")]);
  const detail = await h.request(`/api/v1/send-jobs/${result.body.job.id}`, { cookie: alice.cookie });
  assert.equal(detail.body.job.state, "accepted", detail.text);
  assert.equal(detail.body.job.delivery, "unconfirmed"); assert.equal(detail.body.job.retrySafe, false);
  await h.scheduled(Date.now(), "* * * * *");
  assert.equal(sendCalls(f).length, count + 1);
  assert.equal((await enqueue(key, { ...sendBody, text: "different" })).status, 409);
});

test("future intent stays queued; cancellation wins before reservation and original key cannot recreate it", async () => {
  const key = crypto.randomUUID(), count = sendCalls(f).length;
  const result = await enqueue(key, { ...sendBody, scheduledAt: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(result.status, 201, result.text);
  await h.scheduled(Date.now(), "* * * * *");
  const id = result.body.job.id, actionKey = crypto.randomUUID();
  const cancel = () => h.request(`/api/v1/send-jobs/${id}/cancel`, { method: "POST", cookie: alice.cookie,
    headers: { "idempotency-key": actionKey }, body: { expectedRevision: result.body.job.revision } });
  assert.equal((await cancel()).body.job.state, "cancelled"); assert.equal((await cancel()).status, 200);
  assert.equal((await enqueue(key, { ...sendBody, scheduledAt: result.body.job.scheduledAt })).body.job.state, "cancelled");
  await h.scheduled(Date.now(), "* * * * *"); assert.equal(sendCalls(f).length, count);
});

test("unknown provider result is never automatically resent or made retryable", async () => {
  const count = sendCalls(f).length; f.modes.set("/cf/admin/send_mail_by_binding", "disconnect");
  try {
    const result = await enqueue(); assert.equal(result.status, 201, result.text);
    await h.scheduled(Date.now(), "* * * * *"); await h.restart(); await h.scheduled(Date.now(), "* * * * *");
    const detail = await h.request(`/api/v1/send-jobs/${result.body.job.id}`, { cookie: alice.cookie });
    assert.equal(detail.body.job.state, "unknown", detail.text); assert.equal(detail.body.job.retrySafe, false);
    assert.equal(sendCalls(f).length, count + 1);
  } finally { f.modes.clear(); }
});
