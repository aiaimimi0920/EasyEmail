import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { historyKey, seedAgentRequestHistory, seedAgentEmptyHistory, agentHistoryDigest, exhaustAgentAdmission } from "./agent-capacity-fixture.mjs";

test("more than 10000 Agent request receipts do not block a new receive or lose exact replay across restart", async () => {
  const t = await agentInboxFixture(), key = crypto.randomUUID();
  try {
    const original = expect(await t.receive(key)).operation;
    await seedAgentRequestHistory(t);
    const oldFailed = expect(await t.receipt(historyKey(10005))).operation;
    const before = await agentHistoryDigest(t, "agent_inbox_requests");
    await t.h.restart();
    const next = expect(await t.receive()).operation;
    assert.equal(next.state, "committed"); assert.equal(next.result.stored, 0);
    assert.deepEqual(next.result.cursor, original.result.cursor); assert.equal(next.result.epochId, original.result.epochId);
    assert.equal(t.opens.length, 2);
    await exhaustAgentAdmission(t);
    assert.deepEqual(expect(await t.receive(key)).operation, original);
    assert.deepEqual(expect(await t.receive(historyKey(10005))).operation, oldFailed);
    assert.equal(expect(await t.receive(historyKey(10005), 2), 409).error.code, "idempotency_conflict");
    assert.deepEqual(await agentHistoryDigest(t, "agent_inbox_requests", next.id), before);
    assert.equal(t.opens.length, 2);
    const bob = await t.h.register("agent-capacity-history-bob");
    expect(await t.h.request(`${t.base}/sync-requests/${historyKey(10005)}`, { cookie: bob.cookie }), 404);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});

test("completed empty Agent batches are immutable history, not live capacity, while staged empty intents still reserve slots", async () => {
  const t = await agentInboxFixture();
  try {
    const original = expect(await t.receive()).operation;
    await seedAgentEmptyHistory(t, original);
    const before = await agentHistoryDigest(t, "agent_inbox_batches");
    await t.h.restart();
    const next = expect(await t.receive()).operation;
    assert.equal(next.state, "committed"); assert.equal(next.result.stored, 0); assert.equal(t.opens.length, 2);
    assert.deepEqual(await agentHistoryDigest(t, "agent_inbox_batches", next.result.batchId), before);
    await t.h.db.prepare("UPDATE agent_inbox_batches SET state='staged' WHERE id LIKE 'empty-batch-%'").run();
    expect(await t.receive(), 409); assert.equal(t.opens.length, 2);
    await t.h.db.prepare("UPDATE agent_inbox_batches SET state='retired' WHERE id LIKE 'empty-batch-%'").run();
    assert.equal(expect(await t.receive()).operation.state, "committed"); assert.equal(t.opens.length, 3);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_batches WHERE id LIKE 'empty-batch-%'").first("n"), 1005);
  } finally { await t.close(); }
});
