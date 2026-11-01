import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsMailFixture, followupReply as agentReply } from "./agent-followups-mail-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("inbound root sends real synthetic SMTP follow-ups and atomically owns their replies without task-only FKs", async () => {
  const t = await agentFollowupsMailFixture();
  try {
    const raw = agentReply(null, { headers: "" }); t.scenario({ uidNext: 2, messages: new Map([[1, raw]]) }); expect(await t.receive());
    const seed = expect(await t.inbox()).items[0], root = await t.inbound(seed);
    const input = await t.followupInput(root, { replyToType: "incoming", replyToId: seed.id });
    const outgoing = expect(await t.followup(root, input), 201).followup; assert.equal(outgoing.threadKind, "inbound");
    await t.run(); assert.equal(expect(await t.followupRead(outgoing.id)).followup.state, "accepted"); assert.equal(t.messages.length, 1);
    const seedId = await t.h.db.prepare("SELECT rfc_message_id FROM agent_incoming_messages WHERE id=?").bind(seed.id).first("rfc_message_id");
    assert.ok(t.messages[0].includes(`In-Reply-To: ${seedId}`));
    // Superseding the seed only invalidates that membership, not the root or future incoming members.
    expect(await t.h.request(`${t.base}/messages/${seed.id}/review`, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { accountRevision: 1, epochId: seed.epochId, expectedRevision: 0, state: "dismissed", threadId: null } }));
    const reply = agentReply(outgoing.messageId); t.scenario({ uidNext: 3, messages: new Map([[1, raw], [2, reply]]) }); expect(await t.receive());
    const incoming = expect(await t.inbox(`?threadId=${root}`)).items;
    assert.equal(incoming.length, 1); assert.notEqual(incoming[0].id, seed.id); assert.equal(incoming[0].threadId, null);
    assert.deepEqual(incoming[0].inboundThread, { id: root, active: true }); assert.equal(incoming[0].review.effectiveThreadId, null);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_send_jobs").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT thread_id FROM agent_incoming_messages WHERE id=?").bind(incoming[0].id).first("thread_id"), null);
    const follow = expect(await t.followup(root, { ...input, replyToId: incoming[0].id }), 201).followup;
    await t.h.db.prepare("UPDATE agent_followups SET submitted_at=unixepoch()-61 WHERE id=?").bind(outgoing.id).run();
    await t.run(); assert.equal(expect(await t.followupRead(follow.id)).followup.state, "accepted"); assert.equal(t.messages.length, 2);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});

test("References hitting task plus follow-ups deduplicate by typed root; distinct roots remain ambiguous", async () => {
  const t = await agentFollowupsMailFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run();
    const followup = expect(await t.followup(task.id, await t.followupInput(task.id)), 201).followup; await t.run();
    const other = expect(await t.enqueue(), 201).task;
    await t.h.db.prepare("UPDATE agent_outgoing_messages SET submitted_at=unixepoch()-61 WHERE thread_id=?").bind(task.id).run();
    await t.run();
    const own = agentReply(followup.messageId, { headers: `In-Reply-To: ${followup.messageId}\r\nReferences: ${task.messageId} ${followup.messageId}\r\n` });
    const ambiguous = agentReply(followup.messageId, { headers: `References: ${followup.messageId} ${other.messageId}\r\n` });
    t.scenario({ uidNext: 3, messages: new Map([[1, own], [2, ambiguous]]) }); expect(await t.receive());
    const rows = expect(await t.inbox()).items, first = rows.find(row => row.uid === 1), second = rows.find(row => row.uid === 2);
    assert.equal(first.association, "linked"); assert.equal(first.review.effectiveThreadId, task.id);
    assert.equal(second.association, "ambiguous"); assert.equal(second.review.effectiveThreadId, null);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbound_messages").first("n"), 0);
  } finally { await t.close(); }
});
