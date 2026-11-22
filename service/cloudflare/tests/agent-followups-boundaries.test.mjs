import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsFixture } from "./agent-followups-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("follow-up permissions do not expand old task/state/inbound keys; new scope cannot manage state or configuration", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id);
    const sets = [["agent-tasks:read"], ["agent-tasks:read", "agent-tasks:send"], ["agent-tasks:read", "agent-threads:write"],
      ["agent-inbox:read", "agent-inbox:review", "agent-tasks:read", "agent-services:read", "agent-threads:write"], ["agent-threads:send"]];
    for (const scopes of sets) {
      const key = await newKey(t.h, t.alice.cookie, { scopes }); expect(await t.followup(task.id, input, crypto.randomUUID(), { token: key.token, cookie: undefined }), 403);
    }
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-tasks:read", "agent-threads:send"] });
    const sent = expect(await t.followup(task.id, input, crypto.randomUUID(), { token: key.token, cookie: undefined, origin: null }), 201).followup;
    expect(await t.h.request(`/api/v1/agent-threads/${task.id}/state`, { method: "PUT", token: key.token, headers: { "idempotency-key": crypto.randomUUID() }, body: { state: "archived", expectedRevision: 0 } }), 403);
    expect(await t.h.request(`/api/v1/agent-accounts/${t.accountId}`, { token: key.token }), 403);
    const bob = await t.h.register("followup-bob");
    expect(await t.followupRead(sent.id, { cookie: bob.cookie }), 404);
    expect(await t.followup(task.id, input, crypto.randomUUID(), { cookie: bob.cookie }), 404);
    await t.h.request(`/api/v1/api-keys/${key.id}`, { method: "DELETE", cookie: t.alice.cookie });
    expect(await t.followupRead(sent.id, { token: key.token, cookie: undefined }), 401);
  } finally { await t.close(); }
});

test("follow-up input, origin, fixed root, submitted anchor and management CAS are fail-closed", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task, second = expect(await t.enqueue(), 201).task;
    const base = { ...t.input, expectedThreadRevision: 0, replyToType: "task", replyToId: task.id, confirmUncertain: false };
    expect(await t.followup(task.id, base), 409); await t.run(); await t.run();
    for (const body of [{ ...base, to: "evil@example.test" }, { ...base, references: ["<spoof@example.test>"] }, { ...base, replyToType: "header" },
      { ...base, confirmUncertain: "true" }, { ...base, expectedThreadRevision: -1 }, { ...base, subject: "bad\r\nBcc: x" }]) expect(await t.followup(task.id, body), 400);
    for (const origin of [null, "https://evil.example.test"]) expect(await t.followup(task.id, base, crypto.randomUUID(), { origin }), 403);
    expect(await t.followup(task.id, { ...base, replyToId: second.id }), 409);
    expect(await t.followup(task.id, { ...base, expectedThreadRevision: 2 }), 409);
    expect(await t.h.request(`/api/v1/agent-threads/${task.id}/state`, { method: "PUT", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 0, state: "archived" } }));
    expect(await t.followup(task.id, { ...base, expectedThreadRevision: 1 }), 409);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_sources").first("n"), 0);
  } finally { await t.close(); }
});

test("follow-up source does not use a service default sender and refuses changed real routing", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id);
    const otherAccount = crypto.randomUUID();
    expect(await t.h.request(`/api/v1/agent-accounts/${otherAccount}`, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 0, emailAddress: "other-sender@example.test", displayName: "其他默认账号", endpointId: "example", username: "Alice", password: "Synthetic-IMAP-password", enabled: true } }), 201);
    await t.h.db.prepare("INSERT INTO agent_service_senders(user_id,service_id,account_id) VALUES(?,?,?)").bind(t.alice.id, t.serviceId, otherAccount).run();
    assert.equal(expect(await t.context(task.id)).context.senderAccountId, t.accountId);
    expect(await t.followup(task.id, { ...input, senderAccountId: otherAccount }), 409);
    const first = expect(await t.followup(task.id, input), 201).followup;
    await t.h.db.prepare("UPDATE agent_services SET email_address='other@example.test',version=version+1 WHERE id=?").bind(t.serviceId).run();
    expect(await t.context(task.id), 409);
    expect(await t.followup(task.id, { ...input, serviceVersion: 2 }), 409);
    await t.run(); assert.equal(expect(await t.followupRead(first.id)).followup.state, "failed"); assert.equal(t.messages.length, 1);
    await assert.rejects(t.h.db.prepare("UPDATE agent_thread_sources SET route_hash='changed'").run(), /agent_thread_source_immutable/);
    await assert.rejects(t.h.db.prepare("UPDATE agent_followups SET account_id=? WHERE id=?").bind(crypto.randomUUID(), first.id).run(), /FOREIGN KEY/);
  } finally { await t.close(); }
});

test("a locked route accepts same-address credential and display-version rotation while freezing each new intent", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run();
    const first = expect(await t.followup(task.id, await t.followupInput(task.id)), 201).followup;
    expect(await t.h.request(`/api/v1/agent-followups/${first.id}/cancel`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: 1 } }));
    await t.h.db.batch([
      t.h.db.prepare("UPDATE agent_accounts SET revision=2,display_name='rotated' WHERE id=?").bind(t.accountId),
      t.h.db.prepare("UPDATE agent_smtp_configs SET revision=2,account_revision=2 WHERE account_id=?").bind(t.accountId),
      t.h.db.prepare("UPDATE agent_services SET version=2,display_name='rotated' WHERE id=?").bind(t.serviceId),
    ]);
    const next = expect(await t.followup(task.id, await t.followupInput(task.id)), 201).followup;
    assert.equal(next.accountRevision, 2); assert.equal(next.smtpRevision, 2); assert.equal(next.serviceVersion, 2);
    await t.run(); assert.equal(expect(await t.followupRead(next.id)).followup.state, "accepted"); assert.equal(t.messages.length, 2);
  } finally { await t.close(); }
});
