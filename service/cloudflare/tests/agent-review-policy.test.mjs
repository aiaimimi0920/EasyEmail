import assert from "node:assert/strict";
import { test } from "node:test";
import { agentReviewFixture } from "./agent-review-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("manual targets are bounded and cursor-safe; inactive services and aliases are classification, never authentication", async () => {
  const t = await agentReviewFixture();
  try {
    for (let i = 0; i < 21; i++) await t.task({ subject: `target-${i}` });
    const first = expect(await t.targets()).items, page = expect(await t.targets()); assert.equal(first.length, 20); assert.ok(page.nextCursor);
    const next = expect(await t.targets(`?cursor=${page.nextCursor}`)); assert.equal(next.items.length, 2); assert.equal(next.nextCursor, null);
    const all = [...first, ...next.items]; assert.equal(new Set(all.map(row => row.id)).size, 22); assert.deepEqual(all.map(row => row.id), all.map(row => row.id).sort());
    for (const query of ["?limit=21", "?cursor=", "?limit=1&limit=2", "?unknown=x"]) expect(await t.targets(query), 400);
    const bob = await t.h.register("review-policy-bob"); expect(await t.targets("", { cookie: bob.cookie }), 404);
    await t.h.db.prepare("UPDATE agent_services SET status='archived',trust_level='blocked' WHERE id=?").bind(t.serviceId).run();
    expect(await t.review(t.input("linked", t.firstTask.id))); assert.equal(expect(await t.message(t.incoming.id)).message.authentication, "unverified");
    assert.equal(t.opens.length, 1); assert.equal(await t.h.db.prepare("SELECT state FROM agent_outgoing_messages WHERE id=?").bind(t.firstTask.outgoingId).first("state"), "queued");
    for (const query of ["?review=all", "?review=attention&review=handled"]) expect(await t.messages(query), 400);
  } finally { await t.close(); }
});

test("manual receipts have a bounded cumulative quota; original keys remain recoverable after quota exhaustion", async () => {
  const t = await agentReviewFixture();
  try {
    const key = crypto.randomUUID(), body = t.input("dismissed"), original = expect(await t.review(body, key)).operation;
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<9999)
      INSERT INTO agent_review_operations(id,user_id,account_id,message_id,request_key,request_hash,account_revision,epoch_id,state,thread_id,revision,created_at,completed_at)
      SELECT printf('00000000-0000-0000-0000-%012d',i),user_id,account_id,message_id,printf('00000000-0000-0000-0001-%012d',i),request_hash,account_revision,epoch_id,state,thread_id,revision,created_at,completed_at
      FROM agent_review_operations,n WHERE request_key=?`).bind(key).run();
    const result = await t.review(t.input("attention", null, 1)); expect(result, 409); assert.equal(result.body.error.code, "agent_review_operation_limit");
    assert.deepEqual(expect(await t.review(body, key)).operation, original); assert.deepEqual(expect(await t.reviewReceipt(key)).operation, original);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_review_operations").first("n"), 10000);
    assert.equal(expect(await t.message(t.incoming.id)).message.review.revision, 1);
  } finally { await t.close(); }
});

test("manual links never pin raw/content objects, and retention preserves the original receipt without restoring the overlay", async () => {
  const t = await agentReviewFixture();
  try {
    const key = crypto.randomUUID(), original = expect(await t.review(t.input("linked", t.firstTask.id), key)).operation;
    const bucket = await t.h.bucket("INBOX"); assert.equal((await bucket.list()).objects.length, 2);
    await t.h.db.prepare("UPDATE agent_inbox_batches SET committed_at=unixepoch()-172800 WHERE state='committed'").run();
    await t.h.db.prepare("UPDATE retention_policy SET enabled=1,cache_days=1 WHERE id=1").run(); await t.h.scheduled();
    expect(await t.message(t.incoming.id), 404); assert.equal(expect(await t.messages()).items.length, 0); assert.equal((await bucket.list()).objects.length, 0);
    assert.deepEqual(expect(await t.reviewReceipt(key)).operation, original);
    assert.equal(await t.h.db.prepare("SELECT state FROM agent_incoming_reviews WHERE message_id=?").bind(t.incoming.id).first("state"), "linked");
  } finally { await t.close(); }
});
