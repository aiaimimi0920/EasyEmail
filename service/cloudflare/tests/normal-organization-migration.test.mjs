import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";

test("0027 expands platform state and operation receipts without changing legacy ordinary or temporary tables", async () => {
  const h = await createHarness({}, false, "0026_normal_inbox_search.sql");
  try {
    const tables = ["normal_accounts", "normal_inbox_state", "normal_inbox_messages", "normal_inbox_batches", "normal_inbox_requests", "normal_inbox_search", "messages", "organization_operations"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(table).first()).sql;
    await h.migrate("0027_normal_message_state.sql"); await h.migrate("0027_normal_message_state.sql");
    for (const table of tables) assert.equal((await h.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(table).first()).sql, before[table]);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    await assert.rejects(h.db.prepare("INSERT INTO normal_message_state(message_id) VALUES (?)").bind(crypto.randomUUID()).run(), /FOREIGN KEY/);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await h.close(); }
});
