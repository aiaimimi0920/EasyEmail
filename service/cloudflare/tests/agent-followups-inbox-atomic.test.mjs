import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsMailFixture, followupReply } from "./agent-followups-mail-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("incoming membership failure rolls back inbox commit; lost ACK preserves both membership and cursor exactly once", async () => {
  const t = await agentFollowupsMailFixture();
  try {
    const seedRaw = followupReply(null, { headers: "" }); t.scenario({ uidNext: 2, messages: new Map([[1, seedRaw]]) }); expect(await t.receive());
    const seed = expect(await t.inbox()).items[0], root = await t.inbound(seed);
    const input = await t.followupInput(root, { replyToType: "incoming", replyToId: seed.id });
    const followup = expect(await t.followup(root, input), 201).followup; await t.run();
    t.scenario({ uidNext: 3, messages: new Map([[1, seedRaw], [2, followupReply(followup.messageId)]]) });
    await t.h.db.prepare("CREATE TRIGGER fail_membership BEFORE INSERT ON agent_inbound_messages BEGIN SELECT RAISE(ABORT,'synthetic membership failure'); END").run();
    const failed = expect(await t.receive()).operation;
    assert.equal(failed.state, "failed"); assert.equal(failed.errorCode, "agent_inbox_storage_failed");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_messages").first("n"), 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbound_messages").first("n"), 1);
    assert.equal(await t.h.db.prepare("SELECT after_uid FROM agent_inbox_state").first("after_uid"), 1);
    await t.h.db.prepare("DROP TRIGGER fail_membership").run();
    await t.h.restart({ TEST_FOLLOWUP_FAULT: "inbox-ack" }); assert.equal(expect(await t.receive()).operation.state, "committed");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_messages").first("n"), 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbound_messages").first("n"), 2);
    assert.equal(await t.h.db.prepare("SELECT after_uid FROM agent_inbox_state").first("after_uid"), 2);
    await t.h.restart({ TEST_FOLLOWUP_FAULT: "" }); expect(await t.receive());
    assert.equal(expect(await t.inbox(`?threadId=${root}`)).items.length, 2);
  } finally { await t.close(); }
});

for (const fault of ["review-race", "generation-race", "purge-race"]) test(`incoming anchor rejects late ${fault} before source lock or sending intent exists`, async () => {
  const t = await agentFollowupsMailFixture();
  try {
    t.scenario({ uidNext: 2, messages: new Map([[1, followupReply(null, { headers: "" })]]) }); expect(await t.receive());
    const seed = expect(await t.inbox()).items[0], root = await t.inbound(seed), input = await t.followupInput(root, { replyToType: "incoming", replyToId: seed.id });
    expect(await t.followup(root, input, crypto.randomUUID(), { headers: { "x-test-followup-fault": fault } }), 409);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_sources").first("n"), 0); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
