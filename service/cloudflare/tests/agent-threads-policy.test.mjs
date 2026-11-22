import assert from "node:assert/strict";
import { test } from "node:test";
import { agentThreadsFixture } from "./agent-threads-fixture.mjs";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("archiving a queued task does not cancel it; the original dispatch guard and SMTP result remain authoritative", async () => {
  const t = await agentTasksFixture();
  try {
    const task = expect(await t.enqueue(), 201).task;
    expect(await t.h.request(`/api/v1/agent-threads/${task.id}/state`, { method: "PUT", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 0, state: "archived" } }));
    await t.run(); assert.equal(t.messages.length, 1); await t.run(); assert.equal(t.messages.length, 1);
    const detail = expect(await t.h.request(`/api/v1/agent-threads/${task.id}`, { cookie: t.alice.cookie })).thread;
    assert.equal(detail.management.state, "archived"); assert.equal(detail.task.state, "accepted");
    assert.equal(detail.task.delivery, "unconfirmed"); assert.equal(detail.task.threadState, "awaiting_reply");
    assert.equal(detail.task.revision, 2);
  } finally { await t.close(); }
});

test("default attention follows delivery uncertainty until explicit human state, which survives later delivery and account changes", async () => {
  const t = await agentThreadsFixture();
  try {
    const task = await t.task();
    await t.h.db.prepare("UPDATE agent_outgoing_messages SET state='pending',submitted_at=unixepoch()-61 WHERE id=?").bind(task.outgoingId).run();
    assert.equal(expect(await t.thread(task.id)).thread.management.state, "needs_attention");
    assert.equal(expect(await t.threads("?state=needs_attention")).items.length, 1);
    expect(await t.state(task.id, "completed"));
    await t.h.db.prepare("UPDATE agent_threads SET state='needs_attention' WHERE id=?").bind(task.id).run();
    await t.h.db.prepare("UPDATE agent_accounts SET deleted_at=unixepoch(),revision=revision+1 WHERE id=?").bind(t.id).run();
    const detail = expect(await t.thread(task.id)).thread; assert.equal(detail.management.state, "completed"); assert.equal(detail.task.state, "unknown");
    assert.equal(expect(await t.threads("?state=needs_attention")).items.length, 0);
    expect(await t.state(task.id, "open", 1));
    await t.h.db.prepare("UPDATE agent_outgoing_messages SET state='not_sent',error_code='synthetic_late_failure' WHERE id=?").bind(task.outgoingId).run();
    await t.h.db.prepare("UPDATE agent_threads SET state='failed' WHERE id=?").bind(task.id).run();
    const later = expect(await t.thread(task.id)).thread;
    assert.equal(later.management.state, "open"); assert.equal(later.task.state, "failed"); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("thread operation quota is bounded without deleting old receipts or reapplying original state", async () => {
  const t = await agentThreadsFixture();
  try {
    const task = await t.task(), key = crypto.randomUUID(), first = expect(await t.state(task.id, "archived", 0, key)).operation;
    const original = await t.h.db.prepare("SELECT * FROM agent_thread_operations WHERE request_key=?").bind(key).first();
    const fields = Object.keys(original), values = fields.map(name => ["id", "request_key"].includes(name) ? null : original[name]);
    for (let i = 0; i < 9999; i += 100) await t.h.db.batch(Array.from({ length: Math.min(100, 9999 - i) }, () => {
      const row = [...values]; row[fields.indexOf("id")] = crypto.randomUUID(); row[fields.indexOf("request_key")] = crypto.randomUUID();
      return t.h.db.prepare(`INSERT INTO agent_thread_operations(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`).bind(...row);
    }));
    const limited = await t.state(task.id, "open", 1); expect(limited, 409); assert.equal(limited.body.error.code, "agent_thread_operation_limit");
    assert.deepEqual(expect(await t.state(task.id, "archived", 0, key)).operation, first);
    assert.deepEqual(expect(await t.operation(key)).operation, first);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_operations").first("n"), 10000);
  } finally { await t.close(); }
});
