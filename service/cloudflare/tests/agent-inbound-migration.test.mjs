import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { agentReviewFixture } from "./agent-review-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("0047 preserves every prior table schema and row, old review SQL remains authoritative and FK ownership rejects cross-account membership", async () => {
  const t = await agentReviewFixture({ through: "0046_agent_thread_management.sql" });
  try {
    const tables = (await t.h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const rows = new Map(); for (const table of tables) rows.set(table.name, (await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    await t.h.migrate("0047_agent_inbound_threads.sql"); await t.h.migrate("0047_agent_inbound_threads.sql");
    for (const table of tables) {
      assert.equal(await t.h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql, table.name);
      assert.deepEqual((await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, rows.get(table.name), table.name);
    }
    await upgradePreservingRows(t.h, rows);
    const incoming = expect(await t.messages()).items[0], key = crypto.randomUUID();
    const result = expect(await t.h.request(`${t.base}/messages/${incoming.id}/inbound-thread`, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": key },
      body: { accountRevision: 1, epochId: incoming.epochId, expectedRevision: 0, serviceId: t.serviceId, serviceVersion: 1, confirmRestricted: false } }), 201).operation;
    // Exact old overlay SQL: no knowledge of inbound tables is required to supersede membership.
    await t.h.db.prepare("INSERT INTO agent_incoming_reviews(user_id,account_id,message_id,state,thread_id,revision,updated_at) VALUES(?,?,?,'dismissed',NULL,1,unixepoch())")
      .bind(t.alice.id, t.id, incoming.id).run();
    assert.deepEqual(expect(await t.message(incoming.id)).message.inboundThread, { id: result.threadId, active: false });
    await assert.rejects(t.h.db.prepare("UPDATE agent_inbound_messages SET account_id=? WHERE thread_id=?").bind(crypto.randomUUID(), result.threadId).run(), /FOREIGN KEY/);
    await assert.rejects(t.h.db.prepare("UPDATE agent_inbound_threads SET service_id=? WHERE id=?").bind(crypto.randomUUID(), result.threadId).run(), /FOREIGN KEY/);
    await t.h.restart(); assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
