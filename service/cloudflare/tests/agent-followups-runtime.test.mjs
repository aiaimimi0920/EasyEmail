import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsFixture } from "./agent-followups-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("same task root owns multiple independent follow-ups, MIME parents and shared actual-send quota", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run();
    const input = await t.followupInput(task.id), key = crypto.randomUUID();
    const first = expect(await t.followup(task.id, input, key), 201).followup;
    assert.equal(first.threadId, task.id); assert.equal(first.threadKind, "task"); assert.equal(first.state, "queued");
    assert.equal(first.retrySafe, false); assert.equal(first.delivery, "unconfirmed"); assert.equal(t.messages.length, 1);
    assert.equal(expect(await t.followup(task.id, input, key)).followup.id, first.id);
    assert.equal(expect(await t.followupReceipt(key)).followup.id, first.id);
    expect(await t.followup(task.id, { ...input, text: "changed" }, key), 409);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 1);
    await Promise.all([t.run(), t.run()]);
    const accepted = expect(await t.followupRead(first.id)).followup;
    assert.equal(accepted.state, "accepted"); assert.equal(accepted.cancellable, false);
    assert.equal(t.messages.length, 2); assert.ok(t.messages[1].includes(`In-Reply-To: ${task.messageId}`));
    assert.ok(t.messages[1].includes(`Message-ID: ${first.messageId}`));
    const second = expect(await t.followup(task.id, { ...input, replyToType: "followup", replyToId: first.id, text: "第二次跟进" }), 201).followup;
    await t.run(); assert.equal(t.messages.length, 3);
    assert.ok(t.messages[2].includes(`In-Reply-To: ${first.messageId}`));
    assert.ok(t.messages[2].includes(`References: ${task.messageId}\r\n ${first.messageId}`));
    const items = expect(await t.followupList(task.id)).items;
    assert.deepEqual(new Set(items.map(row => row.id)), new Set([first.id, second.id]));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_outgoing_messages").first("n"), 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 3);
    await t.h.restart(); assert.equal(expect(await t.followupRead(second.id)).followup.state, "accepted");
  } finally { await t.close(); }
});

test("concurrent original-key enqueue is one intent; creator key revocation and later archive do not implicitly cancel it", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id);
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-tasks:read", "agent-threads:send"] }), requestKey = crypto.randomUUID();
    const results = await Promise.all([t.followup(task.id, input, requestKey, { token: key.token }), t.followup(task.id, input, requestKey, { token: key.token })]);
    results.forEach(row => assert.ok([200, 201].includes(row.status), row.text));
    const id = results[0].body.followup.id; assert.equal(results[1].body.followup.id, id);
    expect(await t.h.request(`/api/v1/api-keys/${key.id}`, { method: "DELETE", cookie: t.alice.cookie }));
    expect(await t.h.request(`/api/v1/agent-threads/${task.id}/state`, { method: "PUT", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 0, state: "archived" } }));
    await Promise.all([t.run(), t.run()]); assert.equal(expect(await t.followupRead(id)).followup.state, "accepted"); assert.equal(t.messages.length, 2);
    assert.equal(expect(await t.h.request(`/api/v1/agent-threads/${task.id}`, { cookie: t.alice.cookie })).thread.management.state, "archived");
  } finally { await t.close(); }
});

test("a follow-up already across pending cannot be cancelled while DATA is in flight", async () => {
  const t = await agentFollowupsFixture(); let gate, pending;
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run();
    const followup = expect(await t.followup(task.id, await t.followupInput(task.id)), 201).followup;
    gate = t.hold(); pending = t.run(); await gate.entered;
    const row = expect(await t.followupRead(followup.id)).followup; assert.equal(row.state, "pending"); assert.equal(row.cancellable, false);
    expect(await t.h.request(`/api/v1/agent-followups/${row.id}/cancel`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: row.revision } }), 409);
    gate.release(); await pending; pending = null; assert.equal(expect(await t.followupRead(row.id)).followup.state, "accepted"); assert.equal(t.messages.length, 2);
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); }
});

test("queued follow-up cancellation is explicit, idempotent and never changes manual thread state", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run();
    const followup = expect(await t.followup(task.id, await t.followupInput(task.id)), 201).followup;
    const cancel = () => t.h.request(`/api/v1/agent-followups/${followup.id}/cancel`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: followup.revision } });
    assert.equal(expect(await cancel()).followup.state, "cancelled"); assert.equal(expect(await cancel()).followup.state, "cancelled");
    await t.run(); assert.equal(t.messages.length, 1);
    assert.equal(expect(await t.h.request(`/api/v1/agent-threads/${task.id}`, { cookie: t.alice.cookie })).thread.management.state, "open");
  } finally { await t.close(); }
});
