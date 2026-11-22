import assert from "node:assert/strict";
import { test } from "node:test";
import { agentReviewFixture } from "./agent-review-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("manual attention, link, relink and dismissal preserve header evidence and never dispatch or rewrite delivery", async () => {
  const t = await agentReviewFixture({ linked: true });
  try {
    const original = expect(await t.message(t.incoming.id)).message, a = t.firstTask;
    assert.equal(original.review.revision, 0); assert.equal(original.review.needsAttention, false);
    const b = await t.task();
    const before = (await t.h.db.prepare("SELECT * FROM agent_outgoing_messages ORDER BY id").all()).results, opens = t.opens.length;
    expect(await t.review(t.input("attention"))); assert.equal(expect(await t.messages("?review=attention")).items.length, 1);
    assert.equal(expect(await t.messages(`?threadId=${a.id}`)).items.length, 0);
    const targets = expect(await t.targets()).items; assert.deepEqual(new Set(targets.map(row => row.id)), new Set([a.id, b.id]));
    expect(await t.review(t.input("linked", b.id, 1)));
    const linked = expect(await t.message(original.id)).message;
    assert.equal(linked.threadId, a.id); assert.equal(linked.review.threadId, b.id); assert.equal(linked.review.effectiveThreadId, b.id);
    assert.equal(linked.association, original.association); assert.equal(linked.serviceId, original.serviceId); assert.equal(linked.authentication, "unverified");
    assert.equal(expect(await t.messages(`?threadId=${b.id}`)).items.length, 1); assert.equal(expect(await t.messages("?review=attention")).items.length, 0);
    expect(await t.review(t.input("dismissed", null, 2))); assert.equal(expect(await t.messages(`?threadId=${b.id}`)).items.length, 0);
    expect(await t.review(t.input("attention", null, 3))); assert.equal(expect(await t.message(original.id)).message.review.needsAttention, true);
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM agent_outgoing_messages ORDER BY id").all()).results, before); assert.equal(t.opens.length, opens);
    await t.h.restart(); assert.equal(expect(await t.message(original.id)).message.review.revision, 4);
  } finally { await t.close(); }
});

test("manual review has original immutable receipts, CAS winners and all-or-nothing transaction completion", async () => {
  const t = await agentReviewFixture();
  try {
    const key = crypto.randomUUID(), body = t.input("linked", t.firstTask.id), first = expect(await t.review(body, key)).operation;
    expect(await t.review(t.input("dismissed", null, 1)));
    assert.deepEqual(expect(await t.review(body, key)).operation, first); assert.deepEqual(expect(await t.reviewReceipt(key)).operation, first);
    assert.equal(expect(await t.message(t.incoming.id)).message.review.state, "dismissed"); expect(await t.review(t.input("attention"), key), 409);
    const raced = await Promise.all([t.review(t.input("attention", null, 2)), t.review(t.input("linked", t.firstTask.id, 2))]);
    assert.deepEqual(raced.map(row => row.status).sort(), [200, 409]); assert.equal(expect(await t.message(t.incoming.id)).message.review.revision, 3);
    await t.h.db.prepare("CREATE TRIGGER synthetic_review_failure BEFORE UPDATE OF completed_at ON agent_review_operations BEGIN SELECT RAISE(ABORT,'synthetic-review-rollback'); END").run();
    const failedKey = crypto.randomUUID(); expect(await t.review(t.input("dismissed", null, 3), failedKey), 503);
    assert.equal(expect(await t.message(t.incoming.id)).message.review.revision, 3);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_review_operations WHERE request_key=?").bind(failedKey).first("n"), 0);
    await t.h.db.prepare("DROP TRIGGER synthetic_review_failure").run(); expect(await t.review(t.input("dismissed", null, 3), failedKey));
  } finally { await t.close(); }
});
