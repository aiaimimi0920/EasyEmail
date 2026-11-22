import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { agentThreadsFixture } from "./agent-threads-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

for (const route of ["write", "detail", "list", "receipt", "replay"]) test(`late thread ${route} respects revoked credentials after its real SELECT snapshot`, async () => {
  const gates = await selectGates(), t = await agentThreadsFixture({ testEntry: "./agent-threads-test-worker.ts", bindings: gates.bindings });
  const gate = gates.hold(route, ["receipt", "replay"].includes(route) ? "thread-operation" : "thread"); let pending;
  try {
    const task = await t.task(), key = crypto.randomUUID();
    if (["receipt", "replay"].includes(route)) expect(await t.state(task.id, "archived", 0, key));
    const credential = await newKey(t.h, t.alice.cookie, { scopes: ["agent-tasks:read", "agent-threads:write"] });
    const extra = { token: credential.token, origin: null, headers: gate.headers };
    pending = route === "detail" ? t.thread(task.id, extra) : route === "list" ? t.threads("", extra) : route === "receipt" ? t.operation(key, extra) : t.state(task.id, "archived", 0, key, extra);
    await gate.entered(); expect(await t.h.request(`/api/v1/api-keys/${credential.id}`, { method: "DELETE", cookie: t.alice.cookie }));
    gate.release(); expect(await pending, 401); pending = null;
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_operations").first("n"), ["receipt", "replay"].includes(route) ? 1 : 0);
  } finally { gate.release(); if (pending) await pending; await t.close(); await gates.close(); }
});

test("late CAS loss never overwrites another human decision", async () => {
  const gates = await selectGates(), t = await agentThreadsFixture({ testEntry: "./agent-threads-test-worker.ts", bindings: gates.bindings });
  const gate = gates.hold("cas", "thread"); let pending;
  try {
    const task = await t.task(); pending = t.state(task.id, "completed", 0, undefined, { headers: gate.headers }); await gate.entered();
    expect(await t.state(task.id, "archived")); gate.release(); expect(await pending, 409); pending = null;
    assert.equal(expect(await t.thread(task.id)).thread.management.state, "archived");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_operations").first("n"), 1);
  } finally { gate.release(); if (pending) await pending; await t.close(); await gates.close(); }
});

test("committed thread state with lost ACK reconciles by original key after content retirement", async () => {
  const t = await agentThreadsFixture({ testEntry: "./agent-threads-test-worker.ts" });
  try {
    const task = await t.task(), key = crypto.randomUUID();
    expect(await t.state(task.id, "completed", 0, key, { headers: { "x-test-thread-lost-ack": "true" } }), 503);
    const original = expect(await t.operation(key)).operation; assert.equal(original.revision, 1);
    expect(await t.state(task.id, "open", 1));
    await t.h.db.prepare("UPDATE agent_outgoing_messages SET subject='',text_body='',content_purged_at=unixepoch() WHERE id=?").bind(task.outgoingId).run();
    assert.deepEqual(expect(await t.state(task.id, "completed", 0, key)).operation, original);
    assert.equal(expect(await t.thread(task.id)).thread.management.state, "open"); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
