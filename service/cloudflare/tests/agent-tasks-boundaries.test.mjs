import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { expect, serviceWrite } from "./agent-services-fixture.mjs";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";

test("Agent task authority is explicit, private and Origin-bound, never inherited from SMTP config or normal sending", async () => {
  const t = await agentTasksFixture(), { h, alice } = t;
  try {
    const bob = await h.register("agent-task-bob");
    for (const scopes of [["agent-accounts:read", "agent-accounts:write"], ["agent-services:read", "agent-services:write"], ["mail-accounts:send"], ["agent-tasks:send"]]) {
      const key = await newKey(h, alice.cookie, { scopes }); expect(await t.enqueue(t.input, undefined, { token: key.token, origin: null }), 403);
    }
    expect(await t.enqueue(t.input, undefined, { origin: null }), 403); expect(await t.enqueue(t.input, undefined, { origin: "https://hostile.invalid" }), 403);
    const key = await newKey(h, alice.cookie, { scopes: ["agent-tasks:read", "agent-tasks:send"] });
    const task = expect(await t.enqueue(t.input, undefined, { token: key.token, origin: null }), 201).task;
    expect(await h.request(`/api/v1/agent-tasks/${task.id}`, { cookie: bob.cookie }), 404);
    expect(await h.request(`/api/v1/agent-tasks?requestKey=${task.requestKey}`, { cookie: bob.cookie }), 404);
    expect(await h.request(`/api/v1/agent-tasks/${task.id}/cancel`, { method: "POST", cookie: bob.cookie, body: { expectedRevision: 1 } }), 404);
    expect(await t.enqueue(t.input, undefined, { cookie: bob.cookie }), 404);
    assert.equal(expect(await h.request("/api/v1/agent-tasks", { cookie: bob.cookie })).items.length, 0); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("Agent tasks reject unsupported intentions and stale sources, enforce restricted confirmation and block disabled services", async () => {
  const t = await agentTasksFixture();
  try {
    for (const patch of [{ to: "other@example.test" }, { cc: [] }, { attachments: [] }, { scheduledAt: null }, { senderAccountId: t.id },
      { serviceVersion: 0 }, { smtpRevision: 0 }, { accountRevision: "1" }, { confirmRestricted: "true" }, { subject: "bad\r\nFrom: evil" }, { text: "\ud800" }]) {
      expect(await t.enqueue({ ...t.input, ...patch }), patch.senderAccountId ? 404 : 400);
    }
    expect(await t.enqueue({ ...t.input, serviceVersion: 2 }), 409); expect(await t.enqueue({ ...t.input, smtpRevision: 2 }), 409);
    expect(await t.enqueue(t.input, "bad-key"), 400);
    expect(await serviceWrite(t.h, t.alice, "PATCH", t.serviceId, { expectedVersion: 1, trustLevel: "restricted" }));
    expect(await t.enqueue({ ...t.input, serviceVersion: 2 }), 409);
    expect(await t.enqueue({ ...t.input, serviceVersion: 2, confirmRestricted: true }), 201);
    expect(await serviceWrite(t.h, t.alice, "PATCH", t.serviceId, { expectedVersion: 2, trustLevel: "blocked" }));
    expect(await t.enqueue({ ...t.input, serviceVersion: 3, confirmRestricted: true }), 409);
    await t.run(); assert.equal(t.opens.length, 0);
    for (const suffix of ["?q=x", "?limit=1&limit=2", "?requestKey=bad", "?requestKey=" + crypto.randomUUID() + "&limit=1"])
      expect(await t.h.request("/api/v1/agent-tasks" + suffix, { cookie: t.alice.cookie }), 400);
  } finally { await t.close(); }
});

test("Agent reservations and normal SMTP share the real recipient quota; queued and cancelled intents consume no recipient charge", async () => {
  const t = await agentTasksFixture();
  try {
    expect(await t.configure());
    for (let n = 0; n < 4; n++) expect(await t.enqueue(), 201);
    for (let n = 0; n < 4; n++) await t.run();
    assert.equal(t.messages.length, 3); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 3);
    expect(await t.send(), 409); assert.equal(t.messages.length, 3);
    await t.h.db.prepare("UPDATE agent_outgoing_messages SET submitted_at=unixepoch()-61 WHERE submitted_at IS NOT NULL").run();
    await t.h.db.prepare("UPDATE agent_send_jobs SET next_attempt_at=unixepoch()-1 WHERE state='queued'").run();
    await t.run(); assert.equal(t.messages.length, 4); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 4);
    expect(await t.send(), 201); assert.equal(t.messages.length, 5);
  } finally { await t.close(); }
});

test("Agent task list pages, exact original-key lookups and restart keep ownership and history after service retirement", async () => {
  const t = await agentTasksFixture();
  try {
    const ids = [];
    for (let n = 0; n < 3; n++) ids.push(expect(await t.enqueue({ ...t.input, subject: `Task ${n}` }), 201).task.id);
    const seen = []; let cursor = "";
    do { const page = expect(await t.h.request(`/api/v1/agent-tasks?limit=1${cursor ? `&cursor=${cursor}` : ""}`, { cookie: t.alice.cookie })); seen.push(...page.items.map(row => row.id)); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(seen, ids.sort()); await t.h.restart();
    expect(await serviceWrite(t.h, t.alice, "DELETE", t.serviceId, { expectedVersion: 1 }));
    assert.equal(expect(await t.read(ids[0])).task.id, ids[0]); await t.run(); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
