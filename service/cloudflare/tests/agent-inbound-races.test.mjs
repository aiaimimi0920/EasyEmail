import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboundFixture } from "./agent-inbound-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { expect } from "./agent-services-fixture.mjs";

const scopes = ["agent-inbox:read", "agent-inbox:review", "agent-tasks:read", "agent-services:read", "agent-threads:write"];
for (const change of ["revision", "source", "epoch", "generation", "purge", "review", "service", "revoked-key"]) test(`inbound reservation rejects late ${change} without leaving a root or operation`, async () => {
  const gates = await selectGates(), t = await agentInboundFixture({ testEntry: "./agent-inbound-test-worker.ts", bindings: gates.bindings });
  const gate = gates.hold(change, "agent-incoming"); let pending;
  try {
    const credential = await newKey(t.h, t.alice.cookie, { scopes });
    pending = t.createInbound(t.inputInbound(), undefined, { token: credential.token, origin: null, headers: gate.headers }); await gate.entered();
    if (change === "revision") expect(await t.save({ displayName: "edited after snapshot" }, 1));
    if (change === "source") expect(await t.save({ username: "changed-source" }, 1));
    if (change === "epoch") await t.h.db.prepare("UPDATE agent_inbox_state SET epoch_id=? WHERE account_id=?").bind(crypto.randomUUID(), t.id).run();
    if (change === "generation") await t.h.db.prepare("UPDATE agent_inbox_state SET cache_generation=cache_generation+1 WHERE account_id=?").bind(t.id).run();
    if (change === "purge") await t.h.db.prepare("UPDATE agent_incoming_messages SET purged_at=unixepoch() WHERE id=?").bind(t.incoming.id).run();
    if (change === "review") expect(await t.review(t.input("linked", t.firstTask.id)));
    if (change === "service") await t.h.db.prepare("UPDATE agent_services SET trust_level='blocked' WHERE id=?").bind(t.serviceId).run();
    if (change === "revoked-key") expect(await t.h.request(`/api/v1/api-keys/${credential.id}`, { method: "DELETE", cookie: t.alice.cookie }));
    gate.release(); const result = await pending; pending = null; assert.ok([401, 404, 409].includes(result.status), result.text);
    for (const name of ["agent_inbound_threads", "agent_inbound_messages", "agent_inbound_operations"]) assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${name}`).first("n"), 0);
  } finally { gate.release(); if (pending) await pending; await t.close(); await gates.close(); }
});

for (const route of ["receipt", "replay", "detail"]) test(`late inbound ${route} does not disclose metadata after credential revocation`, async () => {
  const gates = await selectGates(), t = await agentInboundFixture({ testEntry: "./agent-inbound-test-worker.ts", bindings: gates.bindings });
  const gate = gates.hold(route, route === "detail" ? "inbound-thread" : "inbound-operation"); let pending;
  try {
    const key = crypto.randomUUID(), body = t.inputInbound(), receipt = expect(await t.createInbound(body, key), 201).operation;
    const credential = await newKey(t.h, t.alice.cookie, { scopes }), extra = { token: credential.token, origin: null, headers: gate.headers };
    pending = route === "receipt" ? t.inboundReceipt(key, extra) : route === "replay" ? t.createInbound(body, key, extra) : t.thread(receipt.threadId, extra); await gate.entered();
    expect(await t.h.request(`/api/v1/api-keys/${credential.id}`, { method: "DELETE", cookie: t.alice.cookie }));
    gate.release(); const result = await pending; pending = null; expect(result, 401); assert.equal(result.text.includes(receipt.threadId), false);
  } finally { gate.release(); if (pending) await pending; await t.close(); await gates.close(); }
});
