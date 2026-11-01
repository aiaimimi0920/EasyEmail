import assert from "node:assert/strict";
import { test } from "node:test";
import { queueFixture } from "./queue-fixture.mjs";
import { mailboxDeleteFixture } from "./mailbox-delete-fixture.mjs";
import { sendBody, sendCalls } from "./send-fixture.mjs";

test("manual preparation retry is revision fenced and idempotent, with one eventual dispatch", async () => {
  const t = await queueFixture();
  try {
    const result = await t.enqueue(), id = result.body.job.id;
    const config = JSON.parse(t.f.bindings.PROVIDER_CONFIG);
    await t.h.restart({ PROVIDER_CONFIG: JSON.stringify(config.map(c => ({ ...c, enabled: false }))) });
    await t.tick(); const failed = (await t.get(id)).body.job;
    assert.equal(failed.state, "failed"); assert.equal(failed.retrySafe, true); assert.equal(failed.attempts, 1);
    await t.h.restart({ PROVIDER_CONFIG: t.f.bindings.PROVIDER_CONFIG });
    const key = crypto.randomUUID();
    const outcomes = await Promise.all([t.action(failed, "retry", key), t.action(failed, "retry")]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    const own = outcomes[0].status === 200;
    if (own) assert.equal((await t.action(failed, "retry", key)).status, 200);
    assert.equal((await t.get(id)).body.job.manualRetries, 1);
    await t.tick(); await t.tick();
    assert.equal((await t.get(id)).body.job.state, "accepted"); assert.equal(sendCalls(t.f).length, 1);
    assert.equal((await t.action((await t.get(id)).body.job, "retry")).status, 409);
  } finally { await t.close(); }
});

test("new allowlist at actual execution blocks accepted intent rather than sending to an obsolete recipient", async () => {
  const t = await queueFixture();
  try {
    const job = (await t.enqueue()).body.job, configs = JSON.parse(t.f.bindings.PROVIDER_CONFIG);
    configs[0].sendRecipients = ["different@example.test"];
    await t.h.restart({ PROVIDER_CONFIG: JSON.stringify(configs) }); await t.tick();
    const detail = (await t.get(job.id)).body.job;
    assert.equal(detail.state, "failed"); assert.equal(detail.error, "recipient_not_allowed"); assert.equal(sendCalls(t.f).length, 0);
  } finally { await t.close(); }
});

test("queue pagination is complete at tied timestamps and never returns payload bodies", async () => {
  const t = await queueFixture();
  try {
    const job = (await t.enqueue()).body.job, row = await t.h.db.prepare("SELECT * FROM send_jobs WHERE id=?").bind(job.id).first();
    const columns = Object.keys(row), expected = [row.id];
    for (let i = 0; i < 27; i++) {
      const id = crypto.randomUUID(); expected.push(id);
      const copy = { ...row, id, outgoing_key: `queue:${id}`, request_key: crypto.randomUUID() };
      await t.h.db.prepare(`INSERT INTO send_jobs(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .bind(...columns.map(c => copy[c])).run();
    }
    let cursor = ""; const ids = [];
    do {
      const page = await t.h.request(`/api/v1/send-jobs?limit=7${cursor ? `&cursor=${cursor}` : ""}`, { cookie: t.alice.cookie });
      assert.equal(page.status, 200, page.text);
      assert.equal(page.body.items.some(item => "content" in item || "payload_json" in item), false);
      ids.push(...page.body.items.map(item => item.id)); cursor = page.body.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, expected.sort().reverse()); assert.equal(new Set(ids).size, 28);
  } finally { await t.close(); }
});

test("queued intent blocks remote mailbox deletion until explicit cancellation", async () => {
  const t = await mailboxDeleteFixture();
  try {
    const sample = await t.sample();
    const queued = await t.h.request(`/api/v1/mailboxes/${sample.box.id}/send-jobs`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: sendBody });
    assert.equal(queued.status, 201, queued.text);
    const denied = await t.remove(sample); assert.equal(denied.body.error.code, "mailbox_external_operation_unresolved"); assert.equal(t.writes().length, 0);
    const cancelled = await t.h.request(`/api/v1/send-jobs/${queued.body.job.id}/cancel`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: queued.body.job.revision } });
    assert.equal(cancelled.status, 200, cancelled.text);
    const removed = await t.remove(sample); assert.equal(removed.body.deletion.state, "deleted", removed.text); assert.equal(t.writes().length, 1);
  } finally { await t.close(); }
});
