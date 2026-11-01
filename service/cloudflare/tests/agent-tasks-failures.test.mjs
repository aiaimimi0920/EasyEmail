import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";

test("Agent queue never repeats unknown SMTP DATA or retries a rejected body", async () => {
  const t = await agentTasksFixture();
  try {
    for (const [mode, state] of [["drop-final", "unknown"], ["final-reject", "rejected"]]) {
      t.mode(mode); const key = crypto.randomUUID(), task = expect(await t.enqueue(t.input, key), 201).task;
      await t.run(); const result = expect(await t.read(task.id)).task;
      assert.equal(result.state, state); assert.equal(result.retrySafe, false); assert.equal(result.delivery, "unconfirmed");
      const sent = t.messages.length; await t.run(); expect(await t.enqueue(t.input, key)); assert.equal(t.messages.length, sent);
    }
    assert.equal(t.messages.length, 2);
  } finally { await t.close(); }
});

test("Lost Agent reservation acknowledgements never open SMTP; finish failures leave a permanent unknown guard", async () => {
  const t = await agentTasksFixture();
  try {
    for (const fault of ["receipt-lost", "finish"]) {
      const task = expect(await t.enqueue(), 201).task, before = t.messages.length;
      await t.h.restart({ TEST_AGENT_FAULT: fault }); await t.run();
      assert.equal(t.messages.length, before + (fault === "finish" ? 1 : 0));
      await t.h.restart({ TEST_AGENT_FAULT: "" }); await t.run(); assert.equal(expect(await t.read(task.id)).task.state, "pending");
      await t.h.db.prepare("UPDATE agent_outgoing_messages SET submitted_at=unixepoch()-61 WHERE thread_id=?").bind(task.id).run();
      await t.run(); const fresh = expect(await t.read(task.id)).task;
      assert.equal(fresh.state, "unknown"); assert.equal(fresh.threadState, "needs_attention"); assert.equal(fresh.retrySafe, false);
      assert.equal(t.messages.length, before + (fault === "finish" ? 1 : 0));
    }
  } finally { await t.close(); }
});

test("Agent task creation is one transaction and preparation failures have bounded retry before dispatch", async () => {
  const t = await agentTasksFixture();
  try {
    for (const table of ["agent_outgoing_messages", "agent_thread_messages", "agent_send_jobs"]) {
      await t.h.db.prepare(`CREATE TRIGGER fail_task BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'private task failure'); END`).run();
      const response = await t.enqueue(); expect(response, 503); assert.equal(response.text.includes("private task failure"), false);
      for (const name of ["agent_threads", "agent_outgoing_messages", "agent_thread_messages", "agent_send_jobs"])
        assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${name}`).first("n"), 0);
      await t.h.db.prepare("DROP TRIGGER fail_task").run();
    }
    const task = expect(await t.enqueue(), 201).task; await t.h.restart({ MAILBOX_KEYRING: "{}" });
    for (let n = 0; n < 5; n++) { await t.run(); await t.h.db.prepare("UPDATE agent_send_jobs SET next_attempt_at=0 WHERE thread_id=?").bind(task.id).run(); }
    const fresh = expect(await t.read(task.id)).task; assert.equal(fresh.state, "failed"); assert.equal(t.opens.length, 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 0);
  } finally { await t.close(); }
});

test("Agent retention redacts terminal mail content, keeps RFC identity and original guard, and never sends queued expired tasks", async () => {
  const t = await agentTasksFixture();
  try {
    const key = crypto.randomUUID(), task = expect(await t.enqueue(t.input, key), 201).task; await t.run();
    await t.h.db.prepare("UPDATE retention_policy SET enabled=1,outgoing_days=1,revision=revision+1 WHERE id=1").run();
    await t.h.db.prepare("UPDATE agent_outgoing_messages SET updated_at=unixepoch()-86401 WHERE thread_id=?").bind(task.id).run();
    await t.run(); const purged = expect(await t.read(task.id)).task;
    assert.equal(purged.subject, ""); assert.equal(purged.text, ""); assert.ok(purged.contentPurgedAt); assert.equal(purged.messageId, task.messageId);
    expect(await t.enqueue(t.input, key)); await t.run(); assert.equal(t.messages.length, 1);
    const expired = expect(await t.enqueue(), 201).task;
    await t.h.db.prepare("UPDATE agent_send_jobs SET deadline_at=unixepoch()-1 WHERE thread_id=?").bind(expired.id).run(); await t.run();
    assert.equal(expect(await t.read(expired.id)).task.state, "failed"); assert.equal(t.messages.length, 1);
  } finally { await t.close(); }
});
