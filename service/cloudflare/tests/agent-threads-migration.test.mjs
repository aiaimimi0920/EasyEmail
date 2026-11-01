import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { agentThreadsFixture } from "./agent-threads-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("0046 preserves every old table/row and old task writers, with owner-constrained metadata and no destructive rollback", async () => {
  const t = await agentThreadsFixture({ through: "0045_agent_review.sql" });
  try {
    const task = await t.task(), tables = (await t.h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const rows = new Map(); for (const table of tables) rows.set(table.name, (await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    await t.h.migrate("0046_agent_thread_management.sql"); await t.h.migrate("0046_agent_thread_management.sql");
    for (const table of tables) {
      assert.equal(await t.h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql, table.name);
      assert.deepEqual((await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, rows.get(table.name), table.name);
    }
    await upgradePreservingRows(t.h, rows);
    const key = crypto.randomUUID(), operation = expect(await t.state(task.id, "completed", 0, key)).operation;
    const next = await t.task(); assert.equal(expect(await t.thread(next.id)).thread.management.revision, 0);
    expect(await t.h.request(`/api/v1/agent-tasks/${next.id}/cancel`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: 1 } }));
    assert.equal(expect(await t.thread(next.id)).thread.management.state, "archived");
    const bob = await t.h.register("thread-migration-bob");
    await assert.rejects(t.h.db.prepare("UPDATE agent_thread_management SET user_id=? WHERE thread_id=?").bind(bob.id, task.id).run(), /FOREIGN KEY/);
    await assert.rejects(t.h.db.prepare("UPDATE agent_thread_operations SET thread_id=? WHERE request_key=?").bind(crypto.randomUUID(), key).run(), /FOREIGN KEY/);
    await t.h.db.prepare("UPDATE agent_outgoing_messages SET subject='',text_body='',content_purged_at=unixepoch() WHERE thread_id=?").bind(task.id).run();
    await t.h.restart(); assert.deepEqual(expect(await t.operation(key)).operation, operation);
    assert.deepEqual(expect(await t.state(task.id, "completed", 0, key)).operation, operation);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
