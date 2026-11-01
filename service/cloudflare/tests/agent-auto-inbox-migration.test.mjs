import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { autoInboxFixture } from "./agent-auto-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("49-to-50 is additive, defaults off, preserves old schemas/receipts/objects and supplies an indexed due queue across restart", async () => {
  const t = await autoInboxFixture({ through: "0049_agent_inbox_capacity.sql" });
  try {
    const first = expect(await t.receive()).operation; await t.tick(); assert.equal(t.opens.length, 1);
    const tables = (await t.h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const before = new Map(); for (const table of tables) before.set(table.name, (await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    const bucket = await t.h.bucket("INBOX"), key = "agent-inbox/v1/preserve-automation/large.eml", bytes = Uint8Array.from({ length: 2097152 }, (_, i) => i % 251);
    await bucket.put(key, bytes); await t.h.migrate("0050_agent_inbox_automation.sql"); await t.h.migrate("0050_agent_inbox_automation.sql"); await t.h.restart();
    for (const table of tables) {
      assert.equal(await t.h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql);
      assert.deepEqual((await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, before.get(table.name));
    }
    await upgradePreservingRows(t.h, before); await t.h.restart();
    assert.deepEqual(new Uint8Array(await (await (await t.h.bucket("INBOX")).get(key)).arrayBuffer()), bytes);
    assert.equal(expect(await t.config()).config.enabled, false); await t.tick(); assert.equal(t.opens.length, 1);
    assert.deepEqual(expect(await t.receipt(first.requestKey)).operation, first);
    const plan = (await t.h.db.prepare("EXPLAIN QUERY PLAN SELECT account_id FROM agent_inbox_automation WHERE enabled=1 AND next_due_at IS NOT NULL AND next_due_at<=unixepoch() ORDER BY next_due_at,account_id LIMIT 3").all()).results;
    assert.match(JSON.stringify(plan), /agent_inbox_automation_due/);
    const expiryPlan = (await t.h.db.prepare("EXPLAIN QUERY PLAN SELECT account_id FROM agent_inbox_automation WHERE run_token IS NOT NULL AND lease_until<=unixepoch() ORDER BY lease_until,account_id LIMIT 20").all()).results;
    assert.match(JSON.stringify(expiryPlan), /agent_inbox_automation_leases/);
    assert.doesNotMatch(JSON.stringify(expiryPlan), /USE TEMP B-TREE/);
    expect(await t.configure()); await t.tick(); assert.equal(t.opens.length, 2);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
