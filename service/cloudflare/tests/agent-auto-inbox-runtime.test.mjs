import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { autoInboxFixture } from "./agent-auto-inbox-fixture.mjs";
import { agentFollowupsMailFixture, followupReply } from "./agent-followups-mail-fixture.mjs";

test("Agent auto receive is off by default, explicit persistent opt-in schedules real IMAP and survives worker restart", async () => {
  const t = await autoInboxFixture();
  try {
    const off = expect(await t.config()).config; assert.equal(off.enabled, false); assert.equal(off.revision, 0);
    await t.tick(); assert.equal(t.opens.length, 0);
    expect(await t.configure({ persistentAuthorization: false }), 400);
    const key = crypto.randomUUID(), saved = expect(await t.configure({}, key)).operation;
    assert.equal(saved.enabled, true); assert.equal(saved.revision, 1); assert.equal(t.opens.length, 0);
    await t.h.restart(); await t.tick(); assert.equal(t.opens.length, 1);
    assert.equal(expect(await t.messages()).items.length, 2);
    const config = expect(await t.config()).config; assert.equal(config.lastState, "committed"); assert.equal(config.revision, 1);
    assert.ok(config.nextDueAt > config.lastStartedAt); assert.ok(config.lastRequestKey);
    assert.equal(expect(await t.receipt(config.lastRequestKey)).operation.state, "committed");
    await t.tick(); assert.equal(t.opens.length, 1);
    await t.due(); await t.tick(); assert.equal(t.opens.length, 2);
    assert.equal(expect(await t.messages()).items.length, 2);
    assert.deepEqual(expect(await t.configure({}, key)).operation, saved);
  } finally { await t.close(); }
});

test("automatic IMAP commit preserves task and inbound typed-root reply ownership without changing send facts", async () => {
  const t = await agentFollowupsMailFixture();
  try {
    const raw = followupReply(null, { headers: "" }); t.scenario({ uidNext: 2, messages: new Map([[1, raw]]) }); expect(await t.receive());
    const seed = expect(await t.inbox()).items[0], inbound = await t.inbound(seed);
    const task = expect(await t.enqueue(), 201).task; await t.run();
    const followup = expect(await t.followup(inbound, await t.followupInput(inbound, { replyToType: "incoming", replyToId: seed.id })), 201).followup;
    await t.run(); assert.equal(t.messages.length, 2);
    expect(await t.h.request(`${t.base}/auto-inbox`, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedAccountRevision: 1, expectedRevision: 0, enabled: true, intervalMinutes: 15, persistentAuthorization: true } }));
    t.scenario({ uidNext: 4, messages: new Map([[1, raw], [2, followupReply(task.messageId)], [3, followupReply(followup.messageId)]]) });
    await t.run(); assert.equal(expect(await t.h.request(`${t.base}/auto-inbox`, { cookie: t.alice.cookie })).config.lastState, "committed");
    const taskReply = expect(await t.inbox(`?threadId=${task.id}`)).items;
    assert.equal(taskReply.length, 1); assert.equal(taskReply[0].threadId, task.id); assert.equal(taskReply[0].review.effectiveThreadId, task.id);
    const inboundReplies = expect(await t.inbox(`?threadId=${inbound}`)).items;
    assert.equal(inboundReplies.length, 2); assert.deepEqual(inboundReplies.find(row => row.uid === 3).inboundThread, { id: inbound, active: true });
    assert.equal(await t.h.db.prepare("SELECT after_uid FROM agent_inbox_state").first("after_uid"), 3);
    assert.equal(expect(await t.followupRead(followup.id)).followup.state, "accepted"); assert.equal(t.messages.length, 2);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
