import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";

test("0028 expands independent ordinary associations and preserves every legacy table definition", async () => {
  const h = await createHarness({}, false, "0027_normal_message_state.sql");
  try {
    const before = (await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
    await h.migrate("0028_normal_message_taxonomy.sql"); await h.migrate("0028_normal_message_taxonomy.sql");
    for (const table of before) assert.equal((await h.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(table.name).first()).sql, table.sql);
    for (const table of ["normal_message_labels", "normal_message_folders"]) {
      assert.equal(await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
      const foreign = (await h.db.prepare(`PRAGMA foreign_key_list(${table})`).all()).results;
      assert.ok(foreign.some(row => row.table === "normal_inbox_messages"));
      assert.ok(foreign.some(row => row.table === (table.endsWith("labels") ? "labels" : "folders") && row.from === "user_id"));
    }
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await h.close(); }
});
