import assert from "node:assert/strict";
import { test } from "node:test";
import { queueFixture } from "./queue-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { sendBody, sendCalls } from "./send-fixture.mjs";

test("queue ownership, schedule/send/read scopes, strict input and Origin do not extend old API keys", async () => {
  const t = await queueFixture();
  try {
    const old = await newKey(t.h, t.alice.cookie, { scopes: ["messages:send", "messages:read"] });
    const scheduler = await newKey(t.h, t.alice.cookie, { scopes: ["messages:schedule"] });
    const writer = await newKey(t.h, t.alice.cookie, { scopes: ["messages:schedule", "messages:send"] });
    for (const token of [old.token, scheduler.token]) assert.equal((await t.enqueue(sendBody, crypto.randomUUID(), { cookie: null, token, origin: null })).status, 403);
    assert.equal((await t.enqueue(sendBody, crypto.randomUUID(), { origin: null })).status, 403);
    const bob = await t.h.register("queue-security-bob");
    assert.equal((await t.enqueue(sendBody, crypto.randomUUID(), { cookie: bob.cookie })).status, 404);
    for (const scheduledAt of [-1, "tomorrow", 1.1, Math.floor(Date.now() / 1000) - 60, Math.floor(Date.now() / 1000) + 31 * 86400]) {
      assert.equal((await t.enqueue({ ...sendBody, scheduledAt })).status, 400);
    }
    for (const body of [{ ...sendBody, claim: {} }, { ...sendBody, outgoingKey: "spoof" }, { ...sendBody, attachments: [{ id: "spoof", version: "spoof" }] }]) assert.equal((await t.enqueue(body)).status, 400);
    const result = await t.enqueue(sendBody, crypto.randomUUID(), { cookie: null, token: writer.token, origin: null });
    assert.equal(result.status, 201, result.text);
    assert.equal((await t.get(result.body.job.id, { cookie: bob.cookie })).status, 404);
    assert.equal((await t.action(result.body.job, "cancel", crypto.randomUUID(), { cookie: bob.cookie })).status, 404);
    assert.equal((await t.get(result.body.job.id, { cookie: null, token: writer.token })).status, 403);
    assert.equal((await t.h.request("/api/v1/send-jobs", { cookie: bob.cookie })).body.items.length, 0);
    assert.equal(sendCalls(t.f).length, 0);
    // Revocation stops future requests, not an already accepted durable intent.
    await t.h.request(`/api/v1/api-keys/${writer.id}`, { method: "DELETE", cookie: t.alice.cookie });
    await t.tick(); assert.equal((await t.get(result.body.job.id)).body.job.state, "accepted");
    assert.equal((await t.enqueue(sendBody, crypto.randomUUID(), { cookie: null, token: writer.token })).status, 401);
  } finally { await t.close(); }
});

test("atomic active/day admission caps, safe preparation retry bounds and account invalidation", async () => {
  const t = await queueFixture();
  try {
    const results = await Promise.all(Array.from({ length: 22 }, () => t.enqueue({ ...sendBody, scheduledAt: Math.floor(Date.now() / 1000) + 600 })));
    assert.equal(results.filter(r => r.status === 201).length, 20); assert.equal(results.filter(r => r.status === 429).length, 2);
    const job = results.find(r => r.status === 201).body.job;
    await t.h.db.prepare("UPDATE send_jobs SET due_at=unixepoch(),next_attempt_at=unixepoch() WHERE id=?").bind(job.id).run();
    await t.h.db.exec("CREATE TRIGGER reject_queue_guard BEFORE INSERT ON outgoing_messages BEGIN SELECT RAISE(ABORT,'synthetic prepare failure'); END");
    await t.tick();
    let detail = (await t.get(job.id)).body.job; assert.equal(detail.state, "queued"); assert.equal(detail.attempts, 1);
    assert.ok(detail.nextAttemptAt >= Math.floor(Date.now() / 1000) + 58); assert.equal(sendCalls(t.f).length, 0);
    await t.h.db.prepare("UPDATE send_jobs SET next_attempt_at=unixepoch(),attempts=4 WHERE id=?").bind(job.id).run();
    await t.tick(); detail = (await t.get(job.id)).body.job; assert.equal(detail.state, "failed"); assert.equal(detail.attempts, 5); assert.equal(detail.retrySafe, false);
    assert.equal((await t.action(detail, "retry")).status, 409);
    await t.h.db.exec("DROP TRIGGER reject_queue_guard");
    await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
    await t.tick(); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_jobs WHERE state='queued'").first("n"), 0);
    assert.equal(sendCalls(t.f).length, 0);
  } finally { await t.close(); }
});
