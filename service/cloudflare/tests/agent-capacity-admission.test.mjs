import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { exhaustAgentAdmission, seedAgentRequestHistory, agentHistoryDigest } from "./agent-capacity-fixture.mjs";

for (const global of [false, true]) test(`Agent ${global ? "platform" : "user"} admission stays enforced after removing the lifetime receipt limit`, async () => {
  const t = await agentInboxFixture(), key = crypto.randomUUID();
  try {
    const original = expect(await t.receive(key)).operation; await seedAgentRequestHistory(t);
    const before = await agentHistoryDigest(t, "agent_inbox_requests");
    await exhaustAgentAdmission(t, global);
    const blocked = await t.receive(); expect(blocked, 429); assert.equal(blocked.headers.get("retry-after"), "60");
    assert.deepEqual(await agentHistoryDigest(t, "agent_inbox_requests"), before); assert.equal(t.opens.length, 1);
    assert.deepEqual(expect(await t.receive(key)).operation, original); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("concurrent new Agent keys cannot grow permanent configuration failures beyond admission limits, even with more than 10000 receipts", async () => {
  const t = await agentInboxFixture({ noBucket: true });
  try {
    await seedAgentRequestHistory(t); const minute = Math.floor(Date.now() / 60000);
    const keys = Array.from({ length: 32 }, () => crypto.randomUUID()), responses = await Promise.all(keys.map(key => t.receive(key)));
    const windows = Math.floor(Date.now() / 60000) - minute + 1; assert.ok(windows <= 2);
    const accepted = responses.filter(row => row.status === 200), denied = responses.filter(row => row.status === 429);
    assert.ok(accepted.length > 0 && accepted.length <= windows * 10); assert.ok(denied.length > 0);
    assert.equal(accepted.length + denied.length, keys.length);
    for (const row of accepted) { assert.equal(row.body.operation.state, "failed"); assert.equal(row.body.operation.errorCode, "agent_inbox_not_configured"); }
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), 10005 + accepted.length);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_batches").first("n"), 0); assert.equal(t.opens.length, 0);
    const i = responses.findIndex(row => row.status === 429); expect(await t.receipt(keys[i]), 404);
    await t.h.resetLimits(); const retry = expect(await t.receive(keys[i])).operation;
    assert.equal(retry.state, "failed"); assert.equal(retry.errorCode, "agent_inbox_not_configured");
    assert.deepEqual(expect(await t.receive(keys[i])).operation, retry); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("a pending original Agent key still reconciles without admission or a second connection after large history", async () => {
  const t = await agentInboxFixture(), key = crypto.randomUUID(), gate = t.holdPut(); let pending;
  try {
    await seedAgentRequestHistory(t); pending = t.receive(key); await gate.entered;
    await exhaustAgentAdmission(t);
    for (const replay of await Promise.all(Array.from({ length: 8 }, () => t.receive(key)))) assert.equal(expect(replay).operation.state, "pending");
    assert.equal(t.opens.length, 1);
    gate.release(); const committed = expect(await pending).operation; pending = null; assert.equal(committed.state, "committed");
    await t.h.restart(); assert.deepEqual(expect(await t.receive(key)).operation, committed); assert.equal(t.opens.length, 1);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});
