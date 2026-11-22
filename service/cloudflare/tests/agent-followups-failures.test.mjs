import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsFixture } from "./agent-followups-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("enqueue lost ACK reconciles the original immutable intent; real rollback leaves no lock or follow-up", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id), key = crypto.randomUUID();
    await t.h.db.prepare("CREATE TRIGGER fail_followup BEFORE INSERT ON agent_followups BEGIN SELECT RAISE(ABORT,'synthetic after-lock insert failure'); END").run();
    expect(await t.followup(task.id, input, key), 503);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_sources").first("n"), 0); expect(await t.followupReceipt(key), 404);
    await t.h.db.prepare("DROP TRIGGER fail_followup").run();
    expect(await t.followup(task.id, input, key, { headers: { "x-test-followup-fault": "enqueue-ack" } }), 503);
    const receipt = expect(await t.followupReceipt(key)).followup;
    expect(await t.followup(task.id, input, key)); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 1);
    await t.h.restart(); assert.equal(expect(await t.followupReceipt(key)).followup.id, receipt.id); await t.run(); assert.equal(t.messages.length, 2);
  } finally { await t.close(); }
});

for (const fault of ["reservation-ack", "finish"]) test(`follow-up ${fault} never automatically resubmits or releases a charged reservation`, async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id);
    const followup = expect(await t.followup(task.id, input), 201).followup;
    await t.h.restart({ TEST_FOLLOWUP_FAULT: fault }); await t.run();
    assert.equal(expect(await t.followupRead(followup.id)).followup.state, "pending");
    assert.equal(t.messages.length, fault === "finish" ? 2 : 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 2);
    await t.h.db.prepare("UPDATE agent_followups SET submitted_at=unixepoch()-61 WHERE id=?").bind(followup.id).run();
    await t.h.restart({ TEST_FOLLOWUP_FAULT: "" }); await Promise.all([t.run(), t.run()]);
    assert.equal(expect(await t.followupRead(followup.id)).followup.state, "unknown");
    expect(await t.followup(task.id, input), 409);
    const explicit = expect(await t.followup(task.id, { ...input, confirmUncertain: true }), 201).followup;
    assert.notEqual(explicit.id, followup.id); assert.equal(t.messages.length, fault === "finish" ? 2 : 1);
  } finally { await t.close(); }
});

test("read-then-source-change and read-then-revocation cannot commit a follow-up", async () => {
  for (const fault of ["service-race", "revoke-race"]) {
    const t = await agentFollowupsFixture();
    try {
      const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id);
      expect(await t.followup(task.id, input, crypto.randomUUID(), { headers: { "x-test-followup-fault": fault } }), fault === "revoke-race" ? 401 : 409);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 0);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_sources").first("n"), 0);
      assert.equal(t.messages.length, 1);
    } finally { await t.close(); }
  }
});

test("a predecessor becoming unknown after enqueue blocks later unconfirmed intent at its pending boundary", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id);
    const first = expect(await t.followup(task.id, input), 201).followup, second = expect(await t.followup(task.id, input), 201).followup;
    t.mode("drop-final"); await t.run(); assert.equal(t.messages.length, 2); await t.run(); assert.equal(t.messages.length, 2);
    const rows = await Promise.all([t.followupRead(first.id), t.followupRead(second.id)]), states = rows.map(row => expect(row).followup);
    assert.deepEqual(states.map(row => row.state).sort(), ["queued", "unknown"]);
    assert.equal(states.find(row => row.state === "queued").error, "agent_followup_uncertain_predecessor");
    const explicit = expect(await t.followup(task.id, { ...input, confirmUncertain: true }), 201).followup;
    t.mode("normal"); await t.run(); assert.equal(expect(await t.followupRead(explicit.id)).followup.state, "accepted"); assert.equal(t.messages.length, 3);
  } finally { await t.close(); }
});

test("follow-up preparation retries are bounded before submission and expired queued intent never opens SMTP", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id);
    const followup = expect(await t.followup(task.id, input), 201).followup;
    await t.h.restart({ MAILBOX_KEYRING: "{}" });
    for (let i = 0; i < 5; i++) { await t.run(); await t.h.db.prepare("UPDATE agent_followups SET next_attempt_at=0 WHERE id=?").bind(followup.id).run(); }
    const failed = expect(await t.followupRead(followup.id)).followup; assert.equal(failed.state, "failed"); assert.equal(failed.attempts, 4); assert.equal(t.opens.length, 1);
    const expired = expect(await t.followup(task.id, input), 201).followup;
    await t.h.db.prepare("UPDATE agent_followups SET deadline_at=unixepoch()-1 WHERE id=?").bind(expired.id).run(); await t.run();
    assert.equal(expect(await t.followupRead(expired.id)).followup.error, "agent_followup_expired"); assert.equal(t.opens.length, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 1);
  } finally { await t.close(); }
});
