import assert from "node:assert/strict";
import { test } from "node:test";
import { agentGoogleFixture } from "./agent-google-oauth-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("Agent grant installation ACK loss is reconciled once, and rotated refresh ACK loss never repeats a token request", async () => {
  const f = await agentGoogleFixture();
  try {
    assert.equal((await f.put()).status, 201); const started = expect(await f.start());
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    f.mode("short"); const installed = expect(await f.complete(state, undefined, { headers: { "x-test-agent-google-fault": "install-ack" } }));
    assert.equal(installed.replayed, true); expect(await f.complete(state)); assert.equal(f.calls.length, 2);
    f.mode("rotate"); const lost = await f.write(`${f.path}/test`, { expectedRevision: 2 }, undefined, { headers: { "x-test-agent-google-fault": "refresh-ack" } });
    assert.equal(lost.status, 503); assert.equal(f.opens.length, 0);
    const grant = await f.h.db.prepare("SELECT state,version FROM agent_google_oauth_grants").first(); assert.deepEqual(grant, { state: "active", version: 2 });
    // The short rotated token needs another refresh, using the committed rotated token rather than the old one.
    f.mode("normal"); expect(await f.check());
    assert.deepEqual(f.calls.filter(call => call.body.grant_type === "refresh_token").map(call => call.body.refresh_token), ["1//Synthetic-Google-refresh", "1//Synthetic-Google-refresh-rotated"]);
    assert.equal(f.opens.length, 1);
  } finally { await f.close(); }
});

for (const kind of ["task", "followup"]) test(`Agent Google ${kind} reservation ACK loss never opens a socket or replays dispatch`, async () => {
  const f = await agentGoogleFixture();
  try {
    await f.setup(); const first = kind === "followup" ? expect(await f.enqueue(), 201).task : null;
    if (first) await f.tick();
    const body = kind === "followup" ? await f.followupInput(first.id) : f.taskInput;
    const key = crypto.randomUUID(), send = () => kind === "followup" ? f.write(`/api/v1/agent-threads/${first.id}/followups`, body, key) : f.enqueue(key);
    const item = expect(await send(), 201)[kind === "followup" ? "followup" : "task"];
    const count = f.opens.length, calls = f.calls.length;
    await f.h.restart({ TEST_AGENT_GOOGLE_FAULT: `${kind}-ack` }); await f.tick(); assert.equal(f.opens.length, count);
    await f.h.restart({ TEST_AGENT_GOOGLE_FAULT: "" }); expect(await send()); await f.tick();
    if (kind === "task") {
      await f.h.db.prepare("UPDATE agent_outgoing_messages SET submitted_at=unixepoch()-61 WHERE thread_id=?").bind(item.id).run();
      await f.tick(); assert.equal((await f.task(item.id)).state, "unknown");
    } else {
      await f.h.db.prepare("UPDATE agent_followups SET submitted_at=unixepoch()-61 WHERE id=?").bind(item.id).run(); await f.tick();
      assert.equal(expect(await f.h.request(`/api/v1/agent-followups/${item.id}`, { cookie: f.alice.cookie })).followup.state, "unknown");
    }
    assert.equal(f.opens.length, count); assert.equal(f.calls.length, calls);
  } finally { await f.close(); }
});

test("Agent OAuth commit ACK recovery retains inbox cursor, while grant retirement before staging fences the full write", async () => {
  const f = await agentGoogleFixture();
  try {
    await f.setup(); const key = crypto.randomUUID();
    const received = expect(await f.receive(2, key, { headers: { "x-test-agent-google-fault": "commit-ack" } }));
    assert.equal(received.operation.state, "committed"); const count = f.opens.length;
    assert.equal(expect(await f.receive(2, key)).operation.state, "committed"); assert.equal(f.opens.length, count);
    const before = await f.h.db.prepare("SELECT version,after_uid FROM agent_inbox_state WHERE account_id=?").bind(f.id).first();
    const failed = expect(await f.receive(2, undefined, { headers: { "x-test-agent-google-fault": "grant-before-stage" } }));
    assert.equal(failed.operation.state, "failed");
    assert.deepEqual(await f.h.db.prepare("SELECT version,after_uid FROM agent_inbox_state WHERE account_id=?").bind(f.id).first(), before);
    assert.equal((await f.check()).body.error.code, "google_oauth_reauthorization_required");
  } finally { await f.close(); }
});

test("Agent grant version fence is checked atomically before task dispatch", async () => {
  const f = await agentGoogleFixture();
  try {
    await f.setup(); const task = expect(await f.enqueue(), 201).task;
    await f.h.restart({ TEST_AGENT_GOOGLE_FAULT: "grant-before-pending" }); await f.tick();
    assert.equal(f.opens.length, 0); assert.equal((await f.task(task.id)).state, "failed");
    assert.equal((await f.task(task.id)).error, "google_oauth_account_changed");
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 0);
  } finally { await f.close(); }
});
