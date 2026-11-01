import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { seedAgentContentHistory, seedAgentEmptyHistory } from "./agent-capacity-fixture.mjs";
import { RAW_MESSAGE } from "./normal-read-fixture.mjs";

test("Agent request capacity is checked before durable request creation or connection, and staging rechecks actual items before R2", async () => {
  const t = await agentInboxFixture();
  try {
    const original = expect(await t.receive()).operation;
    await seedAgentContentHistory(t, original, 499);
    const count = await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n");
    expect(await t.receive(), 409); assert.equal(t.opens.length, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), count);
    // Leave 998 reserved items: a strict preflight fits, but a real three-item plan does not.
    await t.h.db.prepare("UPDATE agent_inbox_batches SET state='retired' WHERE id='empty-batch-499'").run();
    t.scenario({ uidNext: 11, messages: new Map([[8, RAW_MESSAGE], [9, RAW_MESSAGE], [10, RAW_MESSAGE]]) });
    const bucket = await t.h.bucket("INBOX"), before = (await bucket.list()).objects.map(row => row.key);
    const key = crypto.randomUUID(), failed = expect(await t.receive(key)).operation;
    assert.equal(failed.state, "failed"); assert.equal(failed.errorCode, "agent_inbox_changed_or_limit");
    assert.equal(t.opens.length, 2); assert.deepEqual((await bucket.list()).objects.map(row => row.key), before);
    assert.equal(await t.h.db.prepare("SELECT after_uid FROM agent_inbox_state WHERE account_id=?").bind(t.id).first("after_uid"), 7);
    assert.deepEqual(expect(await t.receive(key)).operation, failed); assert.equal(t.opens.length, 2);
  } finally { await t.close(); }
});

test("Agent byte accounting rejects the full limit before a socket and rechecks actual plan bytes before any object write", async () => {
  const t = await agentInboxFixture();
  try {
    const original = expect(await t.receive()).operation;
    await seedAgentEmptyHistory(t, original, 1);
    const originalBytes = await t.h.db.prepare("SELECT storage_bytes FROM agent_inbox_batches WHERE id=?").bind(original.result.batchId).first("storage_bytes");
    // Synthetic accounting reservation isolates the byte fence; no cleanup is invoked on this row.
    await t.h.db.prepare("UPDATE agent_inbox_batches SET storage_bytes=? WHERE id='empty-batch-1'").bind(134217728 - originalBytes).run();
    expect(await t.receive(), 409); assert.equal(t.opens.length, 1);
    await t.h.db.prepare("UPDATE agent_inbox_batches SET storage_bytes=storage_bytes-1 WHERE id='empty-batch-1'").run();
    t.scenario({ uidNext: 9, messages: new Map([[8, RAW_MESSAGE]]) });
    const failed = expect(await t.receive()).operation;
    assert.equal(failed.state, "failed"); assert.equal(failed.errorCode, "agent_inbox_changed_or_limit");
    assert.equal(t.opens.length, 2); assert.equal((await (await t.h.bucket("INBOX")).list()).objects.length, 4);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_batches").first("n"), 2);
    assert.equal(await t.h.db.prepare("SELECT after_uid FROM agent_inbox_state WHERE account_id=?").bind(t.id).first("after_uid"), 7);
  } finally { await t.close(); }
});

test("retiring Agent content still consumes capacity until every real R2 deletion ACK; old receipts and unknown objects survive", async () => {
  const t = await agentInboxFixture();
  try {
    const original = expect(await t.receive()).operation;
    await seedAgentContentHistory(t, original, 498);
    t.scenario({ uidNext: 10, messages: new Map([[8, RAW_MESSAGE], [9, RAW_MESSAGE]]) });
    t.failOperation("/after-put"); const key = crypto.randomUUID(), failed = expect(await t.receive(key)).operation;
    const batch = await t.h.db.prepare("SELECT * FROM agent_inbox_batches WHERE request_id=?").bind(failed.id).first();
    const bucket = await t.h.bucket("INBOX"), unknown = "agent-inbox/v1/unknown/must-preserve.eml";
    await bucket.put(unknown, "preserve");
    t.failOperation("/after-put", false); t.failOperation("/after-delete");
    await t.h.scheduled(); assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches WHERE id=?").bind(batch.id).first("state"), "retiring");
    expect(await t.receive(), 409); assert.equal(t.opens.length, 2);
    t.failOperation("/after-delete", false); await t.h.scheduled();
    assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches WHERE id=?").bind(batch.id).first("state"), "retired");
    assert.equal(expect(await t.receive()).operation.state, "committed"); assert.equal(t.opens.length, 3);
    assert.deepEqual(expect(await t.receipt(key)).operation, failed); assert.ok(await bucket.head(unknown));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_batches WHERE id LIKE 'empty-batch-%' AND state='committed'").first("n"), 498);
  } finally { await t.close(); }
});
