import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboundFixture } from "./agent-inbound-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("real deferred D1 batch rolls back all four records on a later constraint failure and reconciles actual lost ACKs", async () => {
  const t = await agentInboundFixture({ testEntry: "./agent-inbound-test-worker.ts" });
  try {
    const key = crypto.randomUUID(), body = t.inputInbound();
    expect(await t.createInbound(body, key, { headers: { "x-test-inbound-rollback": "true" } }), 503);
    for (const name of ["agent_inbound_threads", "agent_inbound_messages", "agent_inbound_operations"]) assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${name}`).first("n"), 0);
    expect(await t.inboundReceipt(key), 404);
    expect(await t.createInbound(body, key, { headers: { "x-test-inbound-lost-ack": "true" } }), 503);
    const receipt = expect(await t.inboundReceipt(key)).operation;
    assert.deepEqual(expect(await t.createInbound(body, key)).operation, receipt);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbound_threads").first("n"), 1);
    const stateKey = crypto.randomUUID(); expect(await t.state(receipt.threadId, "archived", 1, stateKey, { headers: { "x-test-inbound-lost-ack": "true" } }), 503);
    const operation = expect(await t.h.request(`/api/v1/agent-thread-operations/${stateKey}`, { cookie: t.alice.cookie })).operation;
    assert.equal(operation.revision, 2); assert.deepEqual(expect(await t.state(receipt.threadId, "archived", 1, stateKey)).operation, operation);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});

test("simultaneous original keys and simultaneous seed creation produce only one inbound root", async () => {
  const t = await agentInboundFixture();
  try {
    const key = crypto.randomUUID(), body = t.inputInbound(), results = await Promise.all([t.createInbound(body, key), t.createInbound(body, key), t.createInbound(body)]);
    assert.equal(results.filter(row => row.status === 201).length, 1);
    assert.ok(results.every(row => [200, 201, 409].includes(row.status)));
    if (results[0].status === 409) assert.equal(results[1].status, 409);
    else assert.deepEqual(results.slice(0, 2).map(row => row.status).sort(), [200, 201]);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbound_operations").first("n"), 1);
    const id = results.find(row => row.status === 201).body.operation.threadId, stateKey = crypto.randomUUID();
    const raced = await Promise.all([t.state(id, "completed", 1, stateKey), t.state(t.firstTask.id, "archived", 0, stateKey)]);
    assert.deepEqual(raced.map(row => row.status).sort(), [200, 409]);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_operation_history").first("n"), 1);
  } finally { await t.close(); }
});

test("thread roots and historical receipts never pin content or bypass source/epoch/account retirement", async () => {
  const t = await agentInboundFixture();
  try {
    const body = t.inputInbound(), key = crypto.randomUUID(), receipt = expect(await t.createInbound(body, key), 201).operation;
    const message = await t.h.db.prepare("SELECT raw_key,content_key FROM agent_incoming_messages WHERE id=?").bind(t.incoming.id).first(), bucket = await t.h.bucket("INBOX");
    assert.ok(await bucket.head(message.raw_key));
    expect(await t.save({ username: "retired-source" }, 1));
    expect(await t.message(t.incoming.id), 404); assert.equal(expect(await t.messages()).items.length, 0);
    await t.h.scheduled();
    assert.equal(await bucket.head(message.raw_key), null); assert.equal(await bucket.head(message.content_key), null);
    assert.ok(await t.h.db.prepare("SELECT purged_at FROM agent_incoming_messages WHERE id=?").bind(t.incoming.id).first("purged_at"));
    const thread = expect(await t.thread(receipt.threadId)).thread;
    assert.equal(thread.kind, "inbound"); assert.equal(Object.hasOwn(thread.inbound, "subject"), false); assert.equal(Object.hasOwn(thread.inbound, "text"), false);
    assert.deepEqual(expect(await t.inboundReceipt(key)).operation, receipt); assert.deepEqual(expect(await t.createInbound(body, key)).operation, receipt);
    await t.h.db.prepare("UPDATE agent_accounts SET deleted_at=unixepoch() WHERE id=?").bind(t.id).run();
    expect(await t.message(t.incoming.id), 404); assert.deepEqual(expect(await t.inboundReceipt(key)).operation, receipt);
    expect(await t.state(receipt.threadId, "archived")); assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});

test("state-operation capacity includes both kinds and database triggers fence a legacy task writer at the shared limit", async () => {
  const t = await agentInboundFixture();
  try {
    const receipt = expect(await t.createInbound(t.inputInbound()), 201).operation;
    await t.h.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
      INSERT INTO agent_inbound_state_operations(id,user_id,thread_id,request_key,request_hash,state,revision,created_at,completed_at)
      SELECT 'capacity-'||x,?,?,'capacity-'||x,'synthetic','open',1,1,1 FROM n`).bind(t.alice.id, receipt.threadId).run();
    const key = crypto.randomUUID(), state = expect(await t.state(t.firstTask.id, "completed", 0, key)).operation;
    expect(await t.state(receipt.threadId, "archived"), 409);
    await assert.rejects(t.h.db.prepare(`INSERT INTO agent_thread_operations(id,user_id,thread_id,request_key,request_hash,state,revision,created_at,completed_at)
      VALUES(?,?,?,?,'legacy','open',1,1,1)`).bind(crypto.randomUUID(), t.alice.id, t.firstTask.id, crypto.randomUUID()).run(), /agent_thread_operation_limit/);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_operation_history").first("n"), 10000);
    assert.deepEqual(expect(await t.state(t.firstTask.id, "completed", 0, key)).operation, state);
  } finally { await t.close(); }
});
