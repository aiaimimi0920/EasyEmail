import assert from "node:assert/strict";
import { test } from "node:test";
import { agentReviewFixture } from "./agent-review-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { agentSmtpInput } from "./agent-smtp-fixture.mjs";

test("manual review is independently scoped, Origin-bound and strictly parsed without widening existing keys", async () => {
  const t = await agentReviewFixture();
  try {
    for (const scopes of [["agent-inbox:read"], ["agent-inbox:read", "agent-accounts:sync"], ["agent-inbox:review"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes }); expect(await t.review(t.input("dismissed"), undefined, { token: key.token, origin: null }), 403);
    }
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-inbox:read", "agent-inbox:review"] });
    expect(await t.review(t.input("linked", t.firstTask.id), undefined, { token: key.token, origin: null }), 403); expect(await t.targets("", { token: key.token, origin: null }), 403);
    expect(await t.review(t.input("dismissed"), undefined, { token: key.token, origin: null }));
    expect(await t.review(t.input("attention", null, 1), undefined, { origin: null }), 403);
    for (const fields of [{ userId: t.alice.id }, { state: "trusted" }, { state: ["attention"] }, { state: {} }, { expectedRevision: -1 }, { accountRevision: "1" }, { epochId: "wrong" }, { state: "linked", threadId: null }, { state: "attention", threadId: t.firstTask.id }]) {
      expect(await t.review({ ...t.input("attention", null, 1), ...fields }), 400);
    }
    expect(await t.review(t.input("attention", null, 1), "invalid"), 400);
    const bob = await t.h.register("manual-review-bob"); expect(await t.review(t.input("attention", null, 1), undefined, { cookie: bob.cookie }), 404);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_review_operations").first("n"), 1);
  } finally { await t.close(); }
});

test("targets and writes reject another receiving account, missing dispatch, stale epoch, purged messages and changed account versions", async () => {
  const t = await agentReviewFixture();
  try {
    const other = crypto.randomUUID(); expect(await t.save({ emailAddress: "other-review@example.test" }, 0, t.alice.cookie, other), 201);
    expect(await t.h.request(`/api/v1/agent-accounts/${other}/smtp`, { method: "PUT", cookie: t.alice.cookie, body: agentSmtpInput, headers: { "idempotency-key": crypto.randomUUID() } }));
    const foreign = await t.task({ senderAccountId: other }), unsent = await t.task({ submitted: false });
    for (const id of [foreign.id, unsent.id, crypto.randomUUID()]) expect(await t.review(t.input("linked", id)), 409);
    assert.deepEqual(expect(await t.targets()).items.map(row => row.id), [t.firstTask.id]);
    expect(await t.review({ ...t.input("dismissed"), accountRevision: 2 }), 409);
    expect(await t.review({ ...t.input("dismissed"), epochId: crypto.randomUUID() }), 409);
    await t.h.db.prepare("UPDATE agent_incoming_messages SET purged_at=unixepoch() WHERE id=?").bind(t.incoming.id).run();
    expect(await t.review(t.input("dismissed")), 404); expect(await t.targets(), 404);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_review_operations").first("n"), 0);
  } finally { await t.close(); }
});
