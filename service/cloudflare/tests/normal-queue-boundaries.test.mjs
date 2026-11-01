import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { normalQueueFixture } from "./normal-queue-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { assetRef } from "./outbox-fixture.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";

let t;
before(async () => { t = await normalQueueFixture(); await t.configure(); });
beforeEach(async () => {
  await t.h.resetLimits(); await t.h.db.exec("DELETE FROM normal_send_job_operations; DELETE FROM normal_send_jobs; DELETE FROM normal_outgoing_messages; DELETE FROM send_job_operations; DELETE FROM send_jobs;");
});
after(async () => { await t?.close(); });
test("normal scheduling has independent scopes; read, attachment and draft authority are not implied", async () => {
  const enqueue = async (scopes, body = mailInput) => {
    const key = await newKey(t.h, t.alice.cookie, { scopes });
    return t.enqueue(body, crypto.randomUUID(), { cookie: null, token: key.token, origin: null });
  };
  for (const scopes of [["messages:schedule", "messages:send"], ["mail-accounts:send"], ["mail-accounts:schedule"]]) assert.equal((await enqueue(scopes)).status, 403);
  const a = await t.upload(); assert.equal((await enqueue(["mail-accounts:schedule", "mail-accounts:send"], { ...mailInput, attachments: [assetRef(a)] })).status, 403);
  const draft = crypto.randomUUID(); await t.save(draft, []);
  assert.equal((await enqueue(["mail-accounts:schedule", "mail-accounts:send"], { ...mailInput, draftId: draft, draftRevision: 1 })).status, 403);
  const queued = await enqueue(["mail-accounts:schedule", "mail-accounts:send"]); assert.equal(queued.status, 201, queued.text);
  const schedule = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:schedule"] });
  const extra = { cookie: null, token: schedule.token, origin: null };
  assert.equal((await t.get(queued.body.job.id, extra)).status, 403);
  assert.equal((await t.action(queued.body.job, "cancel", crypto.randomUUID(), extra)).status, 200);
  assert.equal((await t.action(queued.body.job, "retry", crypto.randomUUID(), extra)).status, 403);
  assert.equal(t.opens.length, 0);
});
test("normal queue reads, actions, cursors and original-key recovery are isolated by account and user", async () => {
  const key = crypto.randomUUID(), result = await t.enqueue(mailInput, key); assert.equal(result.status, 201, result.text);
  const job = result.body.job, foreign = t.root.replace(t.id, crypto.randomUUID()), bob = await t.h.register("normal-queue-bob");
  for (const url of [`${foreign}/${job.id}`, `${foreign}?requestKey=${key}`, `${foreign}?cursor=${job.id}`]) assert.equal((await t.h.request(url, { cookie: t.alice.cookie })).status, 404);
  assert.equal((await t.h.request(`${foreign}/${job.id}/cancel`, { method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: job.revision } })).status, 404);
  assert.equal((await t.get(job.id, { cookie: bob.cookie })).status, 404);
  assert.equal((await t.h.request(`${t.root}?requestKey=${key}`, { cookie: t.alice.cookie })).body.job.id, job.id);
  assert.equal((await t.h.request(`${t.root}?requestKey=${key}&limit=1`, { cookie: t.alice.cookie })).status, 400);
  assert.equal((await t.h.request(`${t.root}?limit=1`, { cookie: t.alice.cookie })).body.items[0].accountId, t.id);
  assert.equal(Object.hasOwn(job, "mailboxId"), false);
});
test("normal schedule bounds and attachment lifetime are validated before durable consumption", async () => {
  const now = Math.floor(Date.now() / 1000), a = await t.upload();
  for (const scheduledAt of [-1, 1.5, "later", now - 10, now + 31 * 86400]) assert.equal((await t.enqueue({ ...mailInput, scheduledAt })).status, 400);
  assert.equal((await t.enqueue({ ...mailInput, scheduledAt: now + 2 * 86400, attachments: [assetRef(a)] })).body.error.code, "attachment_expires_before_schedule");
  const queued = await t.enqueue({ ...mailInput, scheduledAt: now + 600 }); assert.equal(queued.status, 201, queued.text);
  await t.h.db.prepare("UPDATE normal_send_jobs SET scheduled_at=1,due_at=1,deadline_at=1 WHERE id=?").bind(queued.body.job.id).run();
  // Original-key replay precedes current-time eligibility validation.
  assert.equal((await t.enqueue({ ...mailInput, scheduledAt: now + 600 }, queued.body.job.requestKey)).body.job.id, queued.body.job.id);
  await t.tick(); assert.equal((await t.get(queued.body.job.id)).body.job.state, "failed"); assert.equal(t.opens.length, 0);
});
test("temporary and normal jobs share active and daily intent limits", async () => {
  const mailbox = await seedMailbox(t.h, t.alice.id, "shared-limit@example.test"), now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 20; i++) await t.h.db.prepare(`INSERT INTO send_jobs(id,user_id,mailbox_id,request_key,request_hash,outgoing_key,due_at,deadline_at,next_attempt_at,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?, ?,?,'queued',?,?)`).bind(crypto.randomUUID(), t.alice.id, mailbox, crypto.randomUUID(), "hash", crypto.randomUUID(), now, now + 86400, now, now, now).run();
  assert.equal((await t.enqueue()).status, 429);
  await t.h.db.exec("UPDATE send_jobs SET state='cancelled'"); assert.equal((await t.enqueue()).status, 429);
  await t.h.db.exec("UPDATE send_jobs SET created_at=1"); assert.equal((await t.enqueue()).status, 201);
});
test("one minute tick dispatches at most three jobs total and concurrent ticks do not duplicate claims", async () => {
  const count = t.messages.length;
  for (let i = 0; i < 5; i++) assert.equal((await t.enqueue({ ...mailInput, subject: `bounded-${i}` })).status, 201);
  await t.tick(); assert.equal(t.messages.length, count + 3);
  await t.h.db.exec("UPDATE normal_outgoing_messages SET created_at=unixepoch()-61");
  await Promise.all([t.tick(), t.tick()]); assert.equal(t.messages.length, count + 5);
});
test("temporary and ordinary candidates consume one shared three-item runner budget", async () => {
  const mailbox = await seedMailbox(t.h, t.alice.id, "mixed-budget@example.test"), count = t.messages.length;
  for (let i = 0; i < 2; i++) await t.h.db.prepare(`INSERT INTO send_jobs(id,user_id,mailbox_id,request_key,request_hash,outgoing_key,payload_json,due_at,deadline_at,next_attempt_at,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'{}',unixepoch()-10,unixepoch()+86400,unixepoch()-10,'queued',unixepoch(),unixepoch())`)
    .bind(crypto.randomUUID(), t.alice.id, mailbox, crypto.randomUUID(), "hash", crypto.randomUUID()).run();
  for (let i = 0; i < 3; i++) assert.equal((await t.enqueue()).status, 201);
  await t.tick();
  assert.equal(await t.h.db.prepare("SELECT SUM(attempts) n FROM (SELECT attempts FROM send_jobs UNION ALL SELECT attempts FROM normal_send_jobs)").first("n"), 3);
  assert.equal(t.messages.length, count + 1);
});
