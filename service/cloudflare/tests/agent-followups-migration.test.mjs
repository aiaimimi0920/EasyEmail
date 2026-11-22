import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { agentInboundFixture } from "./agent-inbound-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("0048 preserves every prior table and row, task-only FK targets and old actual-charge view semantics", async () => {
  const t = await agentInboundFixture({ through: "0047_agent_inbound_threads.sql" });
  try {
    const seed = expect(await t.messages()).items[0];
    const result = expect(await t.h.request(`${t.base}/messages/${seed.id}/inbound-thread`, { method: "PUT", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { accountRevision: 1, epochId: seed.epochId, expectedRevision: 0,
        serviceId: t.serviceId, serviceVersion: 1, confirmRestricted: false } }), 201).operation;
    const tables = (await t.h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const rows = new Map(); for (const table of tables) rows.set(table.name, (await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    const charges = (await t.h.db.prepare("SELECT * FROM send_recipient_charges").all()).results;
    await t.h.migrate("0048_agent_followups.sql"); await t.h.migrate("0048_agent_followups.sql");
    for (const table of tables) {
      assert.equal(await t.h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql, table.name);
      assert.deepEqual((await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, rows.get(table.name), table.name);
    }
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM send_recipient_charges").all()).results, charges);
    await upgradePreservingRows(t.h, rows);
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM send_recipient_charges").all()).results, charges);
    const followup = expect(await t.h.request(`/api/v1/agent-threads/${result.threadId}/followups`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { serviceId: t.serviceId, serviceVersion: 1, senderAccountId: t.id, accountRevision: 1,
        smtpRevision: 1, subject: "迁移后跟进", text: "合成后续消息", confirmRestricted: false, expectedThreadRevision: 1,
        replyToType: "incoming", replyToId: seed.id, confirmUncertain: false } }), 201).followup;
    assert.equal(followup.threadKind, "inbound"); assert.equal((await t.h.db.prepare("SELECT * FROM send_recipient_charges").all()).results.length, charges.length);
    await t.h.db.prepare("UPDATE agent_followups SET submitted_at=unixepoch(),state='pending' WHERE id=?").bind(followup.id).run();
    assert.equal((await t.h.db.prepare("SELECT * FROM send_recipient_charges").all()).results.length, charges.length + 1);
    await assert.rejects(t.h.db.prepare("UPDATE agent_incoming_messages SET thread_id=? WHERE id=?").bind(result.threadId, seed.id).run(), /FOREIGN KEY/);
    await assert.rejects(t.h.db.prepare("UPDATE agent_followups SET service_id=? WHERE id=?").bind(crypto.randomUUID(), followup.id).run(), /FOREIGN KEY/);
    await t.h.restart(); assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
