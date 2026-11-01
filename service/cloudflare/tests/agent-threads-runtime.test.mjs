import assert from "node:assert/strict";
import { test } from "node:test";
import { agentThreadsFixture } from "./agent-threads-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("task thread lifecycle is private metadata, not cancellation, dispatch, delivery or header evidence", async () => {
  const t = await agentThreadsFixture();
  try {
    const task = await t.task({ submitted: false });
    const tables = ["agent_threads", "agent_send_jobs", "agent_outgoing_messages", "agent_thread_messages"];
    const before = await Promise.all(tables.map(name => t.h.db.prepare(`SELECT * FROM ${name}`).all().then(r => r.results)));
    assert.deepEqual(expect(await t.thread(task.id)).thread.management, { state: "open", revision: 0, manual: false, updatedAt: null });
    for (const [revision, state] of ["needs_attention", "completed", "archived", "open"].entries()) {
      const result = expect(await t.state(task.id, state, revision)).operation;
      assert.equal(result.state, state); assert.equal(result.revision, revision + 1);
      const detail = expect(await t.thread(task.id)).thread;
      assert.equal(detail.kind, "task"); assert.equal(detail.management.state, state); assert.equal(detail.management.manual, true);
      assert.equal(detail.task.state, "queued"); assert.equal(detail.task.delivery, "unconfirmed");
      assert.equal(expect(await t.threads(`?state=${state}`)).items[0].id, task.id);
    }
    assert.deepEqual(await Promise.all(tables.map(name => t.h.db.prepare(`SELECT * FROM ${name}`).all().then(r => r.results))), before);
    assert.equal(t.opens.length, 0); await t.h.restart(); assert.equal(expect(await t.thread(task.id)).thread.management.revision, 4);
  } finally { await t.close(); }
});

test("thread state receipts are immutable, owner-wide original keys with CAS and atomic rollback", async () => {
  const t = await agentThreadsFixture();
  try {
    const a = await t.task(), b = await t.task(), key = crypto.randomUUID();
    const first = expect(await t.state(a.id, "archived", 0, key)).operation;
    expect(await t.state(a.id, "open", 1));
    assert.deepEqual(expect(await t.state(a.id, "archived", 0, key)).operation, first);
    assert.deepEqual(expect(await t.operation(key)).operation, first);
    assert.equal(expect(await t.thread(a.id)).thread.management.state, "open");
    expect(await t.state(a.id, "completed", 0, key), 409); expect(await t.state(b.id, "archived", 0, key), 409);
    const raced = await Promise.all([t.state(a.id, "completed", 2), t.state(a.id, "needs_attention", 2)]);
    assert.deepEqual(raced.map(r => r.status).sort(), [200, 409]);
    await t.h.db.prepare("CREATE TRIGGER synthetic_thread_failure BEFORE UPDATE OF completed_at ON agent_thread_operations BEGIN SELECT RAISE(ABORT,'synthetic-thread-rollback'); END").run();
    const failed = crypto.randomUUID(); expect(await t.state(a.id, "archived", 3, failed), 503);
    assert.equal(expect(await t.thread(a.id)).thread.management.revision, 3);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_operations WHERE request_key=?").bind(failed).first("n"), 0);
    await t.h.db.prepare("DROP TRIGGER synthetic_thread_failure").run(); expect(await t.state(a.id, "archived", 3, failed));
  } finally { await t.close(); }
});
