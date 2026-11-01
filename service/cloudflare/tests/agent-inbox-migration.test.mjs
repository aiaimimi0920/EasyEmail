import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("0043 adds private Agent receive tables without altering any prior table, row or credential", async () => {
  const t = await agentInboxFixture({ through: "0042_agent_tasks.sql" });
  try {
    const tables = (await t.h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const rows = new Map(); for (const table of tables) rows.set(table.name, (await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    await t.h.migrate("0043_agent_inbox.sql"); await t.h.migrate("0043_agent_inbox.sql");
    for (const table of tables) {
      assert.equal(await t.h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql);
      assert.deepEqual((await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, rows.get(table.name), table.name);
    }
    await upgradePreservingRows(t.h, rows);
    assert.equal(expect(await t.receive()).operation.state, "committed");
    const bob = await t.h.register("agent-inbox-fk-bob"), message = expect(await t.messages()).items[0];
    await assert.rejects(t.h.db.prepare("UPDATE agent_incoming_messages SET user_id=? WHERE id=?").bind(bob.id, message.id).run(), /FOREIGN KEY/);
    assert.equal((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  } finally { await t.close(); }
});
