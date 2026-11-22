import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";

test("Agent task atomically creates its thread, real message, mapping and queue; SMTP acceptance remains unconfirmed delivery", async () => {
  const t = await agentTasksFixture();
  try {
    const key = crypto.randomUUID(), created = expect(await t.enqueue(t.input, key), 201).task;
    assert.equal(created.state, "queued"); assert.equal(created.delivery, "unconfirmed"); assert.equal(created.cancellable, true);
    assert.equal(t.opens.length, 0); assert.equal(created.senderAccountId, t.accountId); assert.equal(created.serviceId, t.serviceId);
    for (const table of ["agent_threads", "agent_outgoing_messages", "agent_thread_messages", "agent_send_jobs"])
      assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 1, table);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 0);
    assert.equal(expect(await t.enqueue(t.input, key)).task.id, created.id);
    await t.run(); const submitted = expect(await t.read(created.id)).task;
    assert.equal(submitted.state, "accepted"); assert.equal(submitted.threadState, "awaiting_reply");
    assert.equal(submitted.delivery, "unconfirmed"); assert.equal(submitted.cancellable, false); assert.equal(submitted.retrySafe, false);
    assert.equal(t.messages.length, 1); assert.ok(t.messages[0].includes(`Message-ID: ${submitted.messageId}`));
    assert.ok(t.messages[0].includes("From: <sender@example.test>")); assert.ok(t.messages[0].includes("To: <agent@example.test>"));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 1);
    await Promise.all([t.run(), t.run()]); expect(await t.enqueue(t.input, key)); assert.equal(t.messages.length, 1);
    expect(await t.enqueue({ ...t.input, text: "Different task" }, key), 409);
  } finally { await t.close(); }
});

test("Agent task cancellation before dispatch is final and never opens SMTP", async () => {
  const t = await agentTasksFixture();
  try {
    const task = expect(await t.enqueue(), 201).task, cancel = () => t.h.request(`/api/v1/agent-tasks/${task.id}/cancel`, {
      method: "POST", cookie: t.alice.cookie, body: { expectedRevision: task.revision } });
    assert.equal(expect(await cancel()).task.state, "cancelled"); assert.equal(expect(await cancel()).task.state, "cancelled");
    await t.run(); assert.equal(t.opens.length, 0); assert.equal(expect(await t.read(task.id)).task.cancellable, false);
  } finally { await t.close(); }
});

test("Agent task updatedAt reflects the latest owned thread, message or job transition", async () => {
  const t = await agentTasksFixture();
  try {
    const task = expect(await t.enqueue(), 201).task, now = task.createdAt;
    await t.h.db.batch([
      t.h.db.prepare("UPDATE agent_threads SET updated_at=? WHERE id=?").bind(now + 1, task.id),
      t.h.db.prepare("UPDATE agent_outgoing_messages SET updated_at=? WHERE thread_id=?").bind(now + 3, task.id),
      t.h.db.prepare("UPDATE agent_send_jobs SET updated_at=? WHERE thread_id=?").bind(now + 2, task.id),
    ]);
    assert.equal(expect(await t.read(task.id)).task.updatedAt, now + 3);
  } finally { await t.close(); }
});
