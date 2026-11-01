import assert from "node:assert/strict";
import { test } from "node:test";
import { agentAssociationFixture } from "./agent-inbox-association-fixture.mjs";
import { agentReply } from "./agent-inbox-fixture.mjs";
import { expect, serviceWrite, createService } from "./agent-services-fixture.mjs";
import { agentSmtpInput } from "./agent-smtp-fixture.mjs";

test("actual MIME sender and submitted task headers associate only an unambiguous thread on the receiving account", async () => {
  const t = await agentAssociationFixture();
  try {
    const a = await t.task(), b = await t.task(), unsent = await t.task({ submitted: false });
    const cases = [
      [agentReply(a.messageId.toUpperCase()), "linked", a.id],
      [agentReply(null, { headers: `In-Reply-To: <missing@example.test>\r\nReferences: ${a.messageId}\r\n` }), "linked", a.id],
      [agentReply(a.messageId, { from: "other@example.test" }), "unknown_service", null],
      [agentReply(unsent.messageId), "unmatched", null],
      [agentReply(null, { headers: `References: ${a.messageId} ${b.messageId}\r\n` }), "ambiguous", null],
      [agentReply(a.messageId, { from: "agent@example.test, other@example.test" }), "invalid_headers", null],
      [agentReply(a.messageId, { headers: `From: other@example.test\r\nIn-Reply-To: ${a.messageId}\r\n` }), "invalid_headers", null],
      [agentReply(null, { headers: `Message-ID: ${a.messageId}\r\n` }), "unmatched", null],
    ];
    for (const [index, [raw, association, threadId]] of cases.entries()) {
      await t.h.resetLimits(); t.scenario({ validity: String(50 + index), uidNext: 2, messages: new Map([[1, raw]]) });
      assert.equal(expect(await t.receive()).operation.state, "committed");
      const row = expect(await t.messages()).items[0]; assert.equal(row.association, association, `case ${index}`); assert.equal(row.threadId, threadId);
      assert.equal(row.authentication, "unverified");
    }
    assert.equal(expect(await t.h.request(`/api/v1/agent-tasks/${a.id}`, { cookie: t.alice.cookie })).task.state, "queued", "incoming evidence does not rewrite the delivery state machine");
    expect(await serviceWrite(t.h, t.alice, "PATCH", t.serviceId, { expectedVersion: 1, trustLevel: "blocked" }));
    t.scenario({ validity: "70", uidNext: 2, messages: new Map([[1, agentReply(a.messageId)]]) });
    expect(await t.receive()); assert.equal(expect(await t.messages()).items[0].association, "service_unavailable");
  } finally { await t.close(); }
});

test("a service changed while R2 writes are held is evaluated in the commit transaction, not from an earlier read", async () => {
  const t = await agentAssociationFixture(), gate = t.holdPut(); let pending;
  try {
    const task = await t.task(); t.scenario({ uidNext: 2, messages: new Map([[1, agentReply(task.messageId)]]) });
    pending = t.receive(); await gate.entered;
    expect(await serviceWrite(t.h, t.alice, "PATCH", t.serviceId, { expectedVersion: 1, trustLevel: "blocked" }));
    gate.release(); assert.equal(expect(await pending).operation.state, "committed"); pending = null;
    const row = expect(await t.messages()).items[0]; assert.equal(row.association, "service_unavailable"); assert.equal(row.threadId, null);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("matching RFC headers cannot cross the actual receiving account, service or user owner", async () => {
  const t = await agentAssociationFixture();
  try {
    const otherAccount = crypto.randomUUID(); expect(await t.save({ emailAddress: "other-account@example.test" }, 0, t.alice.cookie, otherAccount), 201);
    expect(await t.h.request(`/api/v1/agent-accounts/${otherAccount}/smtp`, { method: "PUT", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: agentSmtpInput }));
    const a = await t.task({ senderAccountId: otherAccount });
    const otherService = expect(await createService(t.h, t.alice, { displayName: "另一个服务", emailAddress: "other-service@example.test" }), 201).operation.serviceId;
    const b = await t.task({ serviceId: otherService });
    const bob = await t.h.register("agent-association-bob"), bobAccount = crypto.randomUUID();
    expect(await t.save({ emailAddress: "bob@example.test" }, 0, bob.cookie, bobAccount), 201);
    expect(await t.h.request(`/api/v1/agent-accounts/${bobAccount}/smtp`, { method: "PUT", cookie: bob.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: agentSmtpInput }));
    const serviceId = expect(await createService(t.h, bob, { displayName: "相同地址的私有服务", emailAddress: "agent@example.test" }), 201).operation.serviceId;
    const c = expect(await t.h.request("/api/v1/agent-tasks", { method: "POST", cookie: bob.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: {
      serviceId, serviceVersion: 1, senderAccountId: bobAccount, accountRevision: 1, smtpRevision: 1, subject: "另一个用户", text: "不可关联" } }), 201).task;
    await t.h.db.prepare("UPDATE agent_outgoing_messages SET submitted_at=unixepoch() WHERE id=?").bind(c.outgoingId).run();
    t.scenario({ messages: new Map([[1, agentReply(a.messageId)], [2, agentReply(b.messageId)], [3, agentReply(c.messageId)]]), uidNext: 4 });
    assert.equal(expect(await t.receive()).operation.state, "committed"); const rows = expect(await t.messages()).items;
    assert.equal(rows.length, 3); assert.ok(rows.every(row => row.association === "unmatched" && row.threadId === null && row.serviceId === t.serviceId));
  } finally { await t.close(); }
});
