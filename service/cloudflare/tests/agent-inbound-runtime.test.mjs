import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboundFixture } from "./agent-inbound-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("unmatched incoming creates a genuine private inbound root, not a fabricated task or dispatch, and joins the thread lifecycle", async () => {
  const t = await agentInboundFixture();
  try {
    const tables = ["agent_threads", "agent_outgoing_messages", "agent_send_jobs", "agent_incoming_messages", "agent_incoming_reviews", "agent_review_operations"];
    const before = await Promise.all(tables.map(name => t.h.db.prepare(`SELECT * FROM ${name}`).all().then(r => r.results))), key = crypto.randomUUID();
    const body = t.inputInbound(), first = expect(await t.createInbound(body, key), 201).operation;
    assert.equal(first.accountId, t.id); assert.equal(first.messageId, t.incoming.id); assert.equal(first.reviewRevision, 0);
    assert.deepEqual(expect(await t.inboundReceipt(key)).operation, first); assert.deepEqual(expect(await t.createInbound(body, key)).operation, first);
    const detail = expect(await t.thread(first.threadId)).thread;
    assert.equal(detail.kind, "inbound"); assert.equal(Object.hasOwn(detail, "task"), false); assert.equal(detail.inbound.accountId, t.id);
    assert.equal(detail.management.state, "needs_attention"); assert.equal(detail.management.revision, 1);
    const message = expect(await t.message(t.incoming.id)).message;
    assert.deepEqual(message.inboundThread, { id: first.threadId, active: true }); assert.equal(message.authentication, "unverified");
    assert.equal(message.review.needsAttention, false); assert.equal(expect(await t.messages("?review=attention")).items.length, 0);
    assert.equal(expect(await t.messages(`?threadId=${first.threadId}`)).items.length, 1);
    assert.equal(expect(await t.threads()).items.length, 2);
    expect(await t.state(first.threadId, "completed")); expect(await t.state(first.threadId, "archived", 2)); expect(await t.state(first.threadId, "open", 3));
    assert.equal(expect(await t.thread(first.threadId)).thread.management.state, "open");
    assert.deepEqual(await Promise.all(tables.map(name => t.h.db.prepare(`SELECT * FROM ${name}`).all().then(r => r.results))), before);
    assert.equal(t.opens.length, 1); await t.h.restart(); assert.equal(expect(await t.thread(first.threadId)).thread.management.revision, 4);
  } finally { await t.close(); }
});

test("a later legacy review decision invalidates inbound membership without destroying the root or rewriting original creation receipts", async () => {
  const t = await agentInboundFixture();
  try {
    const key = crypto.randomUUID(), body = t.inputInbound(), receipt = expect(await t.createInbound(body, key), 201).operation;
    expect(await t.review(t.input("linked", t.firstTask.id)));
    const message = expect(await t.message(t.incoming.id)).message;
    assert.deepEqual(message.inboundThread, { id: receipt.threadId, active: false }); assert.equal(message.review.effectiveThreadId, t.firstTask.id);
    assert.equal(expect(await t.messages(`?threadId=${receipt.threadId}`)).items.length, 0);
    assert.equal(expect(await t.messages(`?threadId=${t.firstTask.id}`)).items.length, 1);
    expect(await t.createInbound(t.inputInbound({ expectedRevision: 1 })), 409);
    assert.deepEqual(expect(await t.createInbound(body, key)).operation, receipt);
    assert.equal(expect(await t.thread(receipt.threadId)).thread.inbound.memberActive, false);
  } finally { await t.close(); }
});
