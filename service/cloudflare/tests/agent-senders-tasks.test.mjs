import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";
import { serviceWrite, expect } from "./agent-services-fixture.mjs";
import { agentWrite, agentAccountInput } from "./agent-accounts-fixture.mjs";
import { SMTP_PASSWORD } from "./normal-send-fixture.mjs";

test("defaults do not implicitly send: explicit override is frozen and default changes never retarget queued tasks", async () => {
  const t = await agentTasksFixture(), { h, alice } = t;
  try {
    expect(await serviceWrite(h, alice, "PATCH", t.serviceId, { expectedVersion: 1, defaultSenderAccountId: t.accountId }));
    const implicit = { ...t.input, serviceVersion: 2 }; delete implicit.senderAccountId; delete implicit.accountRevision; delete implicit.smtpRevision;
    expect(await t.enqueue(implicit), 400); assert.equal(t.opens.length, 0);
    const otherId = crypto.randomUUID(); expect(await agentWrite(h, alice, otherId, { ...agentAccountInput, emailAddress: "explicit-override@example.test", username: "Alice" }), 201);
    expect(await h.request(`/api/v1/agent-accounts/${otherId}/smtp`, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 1, smtpRevision: 0, endpointId: "example", username: "Alice", password: SMTP_PASSWORD, enabled: true } }));
    const input = { ...t.input, serviceVersion: 2, senderAccountId: otherId }, key = crypto.randomUUID();
    const task = expect(await t.enqueue(input, key), 201).task;
    assert.equal(task.senderAccountId, otherId); assert.equal(task.from, "explicit-override@example.test");
    expect(await serviceWrite(h, alice, "PATCH", t.serviceId, { expectedVersion: 2, defaultSenderAccountId: null }));
    await t.run(); const failed = expect(await t.read(task.id)).task;
    assert.equal(failed.state, "failed"); assert.equal(failed.senderAccountId, otherId); assert.equal(t.opens.length, 0);
    const replay = expect(await t.enqueue(input, key)).task; assert.equal(replay.id, task.id); assert.equal(replay.senderAccountId, otherId);
    const current = expect(await t.enqueue({ ...t.input, serviceVersion: 3 }), 201).task;
    await t.run(); assert.equal(expect(await t.read(current.id)).task.state, "accepted"); assert.equal(t.messages.length, 1);
    assert.match(t.messages[0], /From: <sender@example\.test>/);
  } finally { await t.close(); }
});
