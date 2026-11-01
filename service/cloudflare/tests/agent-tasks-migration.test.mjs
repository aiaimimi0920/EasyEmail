import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { agentSmtpFixture } from "./agent-smtp-fixture.mjs";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("0042 preserves existing table definitions and rows while expanding the non-owning quota view", async () => {
  const t = await agentSmtpFixture({ through: "0041_agent_smtp.sql" });
  try {
    expect(await t.configure());
    const tables = (await t.h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const snapshots = new Map();
    for (const table of tables) snapshots.set(table.name, (await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    const before = (await t.h.db.prepare("SELECT * FROM send_recipient_charges").all()).results;
    await t.h.migrate("0042_agent_tasks.sql"); await t.h.migrate("0042_agent_tasks.sql");
    for (const table of tables) {
      assert.equal(await t.h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql);
      assert.deepEqual((await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, snapshots.get(table.name), table.name);
    }
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM send_recipient_charges").all()).results, before);
    assert.ok((await t.h.db.prepare("SELECT sql FROM sqlite_master WHERE name='send_recipient_charges'").first("sql")).includes("agent_outgoing_messages"));
    await upgradePreservingRows(t.h, snapshots);
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM send_recipient_charges").all()).results, before);
  } finally { await t.close(); }
});

test("Agent task ownership FKs bind the actual thread and outgoing, not only existing IDs", async () => {
  const t = await agentTasksFixture();
  try {
    const first = expect(await t.enqueue(), 201).task, second = expect(await t.enqueue(), 201).task, bob = await t.h.register("agent-task-fk-bob");
    await assert.rejects(t.h.db.prepare("UPDATE agent_outgoing_messages SET user_id=? WHERE thread_id=?").bind(bob.id, first.id).run(), /FOREIGN KEY/);
    await assert.rejects(t.h.db.prepare("UPDATE agent_send_jobs SET outgoing_id=? WHERE thread_id=?").bind(second.outgoingId, first.id).run(), /FOREIGN KEY|UNIQUE/);
    await assert.rejects(t.h.db.prepare("UPDATE agent_thread_messages SET outgoing_id=? WHERE thread_id=?").bind(second.outgoingId, first.id).run(), /FOREIGN KEY/);
    await t.h.restart(); assert.equal(expect(await t.read(first.id)).task.messageId, first.messageId);
  } finally { await t.close(); }
});
