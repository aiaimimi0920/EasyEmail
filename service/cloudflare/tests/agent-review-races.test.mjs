import assert from "node:assert/strict";
import { test } from "node:test";
import { agentReviewFixture } from "./agent-review-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { expect } from "./agent-services-fixture.mjs";

for (const change of ["revision", "source", "epoch", "generation", "purge", "revoked-key"]) test(`manual review reservation rejects a late ${change}`, async () => {
  const gates = await selectGates(), t = await agentReviewFixture({ testEntry: "./agent-review-test-worker.ts", bindings: gates.bindings });
  const gate = gates.hold(change, "agent-incoming"); let pending;
  try {
    const credential = await newKey(t.h, t.alice.cookie, { scopes: ["agent-inbox:read", "agent-inbox:review"] });
    pending = t.review(t.input("dismissed"), undefined, { token: credential.token, origin: null, headers: gate.headers }); await gate.entered();
    if (change === "revision") expect(await t.save({ displayName: "edited after snapshot" }, 1));
    if (change === "source") expect(await t.save({ username: "new-source" }, 1));
    if (change === "epoch") await t.h.db.prepare("UPDATE agent_inbox_state SET epoch_id=? WHERE account_id=?").bind(crypto.randomUUID(), t.id).run();
    if (change === "generation") await t.h.db.prepare("UPDATE agent_inbox_state SET cache_generation=cache_generation+1 WHERE account_id=?").bind(t.id).run();
    if (change === "purge") await t.h.db.prepare("UPDATE agent_incoming_messages SET purged_at=unixepoch() WHERE id=?").bind(t.incoming.id).run();
    if (change === "revoked-key") expect(await t.h.request(`/api/v1/api-keys/${credential.id}`, { method: "DELETE", cookie: t.alice.cookie }));
    gate.release(); const result = await pending; pending = null; assert.ok([401, 404, 409].includes(result.status), result.text);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_review_operations").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_reviews").first("n"), 0);
  } finally { gate.release(); if (pending) await pending; await t.close(); await gates.close(); }
});

for (const route of ["receipt", "replay"]) test(`late manual ${route} cannot disclose a receipt after credential revocation`, async () => {
  const gates = await selectGates(), t = await agentReviewFixture({ testEntry: "./agent-review-test-worker.ts", bindings: gates.bindings });
  const gate = gates.hold(route, "agent-review-operation"); let pending;
  try {
    const key = crypto.randomUUID(), body = t.input("linked", t.firstTask.id); expect(await t.review(body, key));
    const credential = await newKey(t.h, t.alice.cookie, { scopes: ["agent-inbox:read", "agent-inbox:review", "agent-tasks:read"] });
    const extra = { token: credential.token, origin: null, headers: gate.headers };
    pending = route === "receipt" ? t.reviewReceipt(key, extra) : t.review(body, key, extra); await gate.entered();
    expect(await t.h.request(`/api/v1/api-keys/${credential.id}`, { method: "DELETE", cookie: t.alice.cookie }));
    gate.release(); const result = await pending; pending = null; expect(result, 401); assert.equal(result.text.includes(t.firstTask.id), false);
  } finally { gate.release(); if (pending) await pending; await t.close(); await gates.close(); }
});

test("a committed batch with a lost ACK recovers its immutable original receipt, including after message purge", async () => {
  const t = await agentReviewFixture({ testEntry: "./agent-review-test-worker.ts" });
  try {
    const key = crypto.randomUUID(), body = t.input("linked", t.firstTask.id);
    expect(await t.review(body, key, { headers: { "x-test-review-lost-ack": "true" } }), 503);
    const original = expect(await t.reviewReceipt(key)).operation; assert.equal(original.revision, 1);
    expect(await t.review(t.input("dismissed", null, 1)));
    await t.h.db.prepare("UPDATE agent_incoming_messages SET purged_at=unixepoch() WHERE id=?").bind(t.incoming.id).run();
    assert.deepEqual(expect(await t.review(body, key)).operation, original); assert.deepEqual(expect(await t.reviewReceipt(key)).operation, original);
    assert.equal(await t.h.db.prepare("SELECT revision FROM agent_incoming_reviews WHERE message_id=?").bind(t.incoming.id).first("revision"), 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_review_operations").first("n"), 2);
  } finally { await t.close(); }
});
