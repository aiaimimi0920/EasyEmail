import assert from "node:assert/strict";
import { test } from "node:test";
import { agentGoogleFixture, entered } from "./agent-google-oauth-fixture.mjs";
import { EMAIL, ACCESS } from "./google-oauth-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { agentReply } from "./agent-inbox-fixture.mjs";

test("Agent Google grant spans IMAP, task, header-linked reply, followup and explicitly authorized scheduled inbox", async () => {
  const f = await agentGoogleFixture();
  try {
    await f.setup(); expect(await f.check()); const key = crypto.randomUUID(), first = expect(await f.enqueue(key), 201).task;
    await f.tick(); assert.equal((await f.task(first.id)).state, "accepted");
    const reply = agentReply(first.messageId, { from: "agent@example.test" });
    f.mailMode("imap", { read: { messages: new Map([[1, reply]]), uidNext: 2 } });
    const received = expect(await f.receive()); assert.equal(received.operation.state, "committed");
    const inbox = expect(await f.h.request(`${f.path}/messages`, { cookie: f.alice.cookie })).items;
    assert.equal(inbox.length, 1); assert.equal(inbox[0].threadId, first.id); assert.equal(inbox[0].authentication, "unverified");
    const input = await f.followupInput(first.id), next = expect(await f.write(`/api/v1/agent-threads/${first.id}/followups`, input), 201).followup;
    await f.tick(); assert.equal(expect(await f.h.request(`/api/v1/agent-followups/${next.id}`, { cookie: f.alice.cookie })).followup.state, "accepted");
    expect(await f.auto()); await f.tick();
    const config = expect(await f.h.request(`${f.path}/auto-inbox`, { cookie: f.alice.cookie })).config;
    assert.equal(config.lastState, "committed"); assert.equal(config.ready, true);
    assert.equal(expect(await f.enqueue(key)).replayed, true); const count = f.opens.length; await f.tick(); assert.equal(f.opens.length, count);
    for (const { peer } of f.sessions.values()) assert.deepEqual(peer.credentials, [{ method: "XOAUTH2", value: `user=${EMAIL}\x01auth=Bearer ${ACCESS}\x01\x01` }]);
    for (const table of ["normal_accounts", "normal_smtp_configs", "normal_inbox_messages", "normal_outgoing_messages", "google_oauth_grants"])
      assert.equal(await f.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0, table);
    assert.equal((JSON.stringify(inbox) + JSON.stringify(config)).includes(ACCESS), false);
  } finally { await f.close(); }
});

test("Agent refresh is shared across IMAP and tasks, does not edit the account or silently invalidate automatic authority", async () => {
  const f = await agentGoogleFixture(); let gate, pending;
  try {
    f.mode("short"); await f.setup(); expect(await f.auto()); f.mode("normal");
    gate = f.hold(); pending = f.check(); await entered(gate);
    const first = expect(await f.enqueue(), 201).task; await f.tick(); assert.equal(f.opens.length, 0);
    assert.equal((await f.task(first.id)).state, "queued");
    gate.release(); expect(await pending); assert.equal(f.opens.length, 1);
    const config = expect(await f.h.request(`${f.path}/auto-inbox`, { cookie: f.alice.cookie })).config;
    assert.equal(config.accountRevision, 2); assert.equal(config.ready, true);
    await f.h.db.prepare("UPDATE agent_send_jobs SET next_attempt_at=0 WHERE thread_id=?").bind(first.id).run();
    await f.tick(); assert.equal((await f.task(first.id)).state, "accepted");
    await f.h.db.prepare("UPDATE agent_inbox_automation SET next_due_at=0 WHERE account_id=?").bind(f.id).run();
    await f.tick(); assert.equal(f.calls.filter(c => c.body.grant_type === "refresh_token").length, 1);
    assert.equal(expect(await f.h.request(`${f.path}/auto-inbox`, { cookie: f.alice.cookie })).config.lastState, "committed");
  } finally { gate?.release(); await pending; await f.close(); }
});

test("Agent Google DATA uncertainty is not an OAuth retry: original task and followup remain unknown without more sockets or token requests", async () => {
  const f = await agentGoogleFixture();
  try {
    await f.setup(); f.mailMode("smtp", { final: "drop" });
    const key = crypto.randomUUID(), first = expect(await f.enqueue(key), 201).task; await f.tick();
    assert.equal((await f.task(first.id)).state, "unknown"); const calls = f.calls.length, opens = f.opens.length;
    expect(await f.enqueue(key)); await f.tick(); assert.equal(f.opens.length, opens); assert.equal(f.calls.length, calls);
    const input = await f.followupInput(first.id, { confirmUncertain: true });
    const followupKey = crypto.randomUUID(), send = () => f.write(`/api/v1/agent-threads/${first.id}/followups`, input, followupKey);
    const next = expect(await send(), 201).followup; await f.tick();
    assert.equal(expect(await f.h.request(`/api/v1/agent-followups/${next.id}`, { cookie: f.alice.cookie })).followup.state, "unknown");
    const count = f.opens.length; expect(await send()); await f.tick(); assert.equal(f.opens.length, count); assert.equal(f.calls.length, calls);
  } finally { await f.close(); }
});
