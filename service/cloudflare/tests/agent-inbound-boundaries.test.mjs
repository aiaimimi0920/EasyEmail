import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboundFixture } from "./agent-inbound-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { expect, createService } from "./agent-services-fixture.mjs";

export const inboundScopes = ["agent-inbox:read", "agent-inbox:review", "agent-tasks:read", "agent-services:read", "agent-threads:write"];
test("inbound creation requires every explicit scope, owned resources, Origin and strict complete input; old Keys do not acquire write powers", async () => {
  const t = await agentInboundFixture();
  try {
    const bob = await t.h.register("inbound-boundary-bob");
    for (const missing of inboundScopes) {
      const key = await newKey(t.h, t.alice.cookie, { scopes: inboundScopes.filter(scope => scope !== missing) });
      expect(await t.createInbound(t.inputInbound(), undefined, { token: key.token, origin: null }), 403);
    }
    expect(await t.createInbound(t.inputInbound(), undefined, { origin: "https://evil.example" }), 403);
    expect(await t.createInbound(t.inputInbound(), undefined, { cookie: bob.cookie }), 404);
    const badInputs = [{ extra: true }, { epochId: "bad" }, { expectedRevision: -1 }, { accountRevision: 0 }, { serviceVersion: 1.1 }, { confirmRestricted: "true" }];
    for (const bad of badInputs) expect(await t.createInbound(t.inputInbound(bad)), 400);
    const partial = t.inputInbound(); delete partial.confirmRestricted; expect(await t.createInbound(partial), 400);
    expect(await t.createInbound(t.inputInbound(), "bad-key"), 400);
    const foreign = expect(await createService(t.h, bob), 201).operation.serviceId;
    expect(await t.createInbound(t.inputInbound({ serviceId: foreign })), 409);
    expect(await t.createInbound(t.inputInbound({ serviceVersion: 2 })), 409);
    expect(await t.createInbound(t.inputInbound({ accountRevision: 2 })), 409);
    expect(await t.createInbound(t.inputInbound({ epochId: crypto.randomUUID() })), 409);
    const key = await newKey(t.h, t.alice.cookie, { scopes: inboundScopes });
    const receipt = expect(await t.createInbound(t.inputInbound(), undefined, { token: key.token, origin: null }), 201).operation;
    expect(await t.message(t.incoming.id, { token: key.token, origin: null }));
    expect(await t.h.request("/api/v1/agent-tasks", { method: "POST", token: key.token, body: {} }), 403);
    expect(await t.receive(undefined, 1, { token: key.token }), 403);
    expect(await t.thread(receipt.threadId, { cookie: bob.cookie }), 404);
    expect(await t.inboundReceipt(receipt.requestKey, { cookie: bob.cookie }), 404);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("inbound creation cannot steal an effective task association; disabled, blocked and restricted services are fenced", async () => {
  const t = await agentInboundFixture({ linked: true });
  try {
    expect(await t.createInbound(t.inputInbound()), 409);
    expect(await t.review(t.input("attention")));
    for (const values of [["disabled", "trusted"], ["archived", "trusted"], ["active", "blocked"], ["active", "restricted"]]) {
      await t.h.db.prepare("UPDATE agent_services SET status=?,trust_level=? WHERE id=?").bind(...values, t.serviceId).run();
      expect(await t.createInbound(t.inputInbound({ expectedRevision: 1 })), 409);
    }
    expect(await t.createInbound(t.inputInbound({ expectedRevision: 1, confirmRestricted: true })), 201);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbound_threads").first("n"), 1);
  } finally { await t.close(); }
});

test("complete creation keys are immutable, property order is irrelevant and later edits never overwrite a creation receipt", async () => {
  const t = await agentInboundFixture();
  try {
    const key = crypto.randomUUID(), body = t.inputInbound(), receipt = expect(await t.createInbound(body, key), 201).operation;
    assert.deepEqual(expect(await t.createInbound(Object.fromEntries(Object.entries(body).reverse()), key)).operation, receipt);
    for (const patch of [{ expectedRevision: 1 }, { serviceVersion: 2 }, { confirmRestricted: true }, { serviceId: crypto.randomUUID() }])
      expect(await t.createInbound({ ...body, ...patch }, key), 409);
    expect(await t.createInbound(body), 409);
    const rows = await Promise.all(Array.from({ length: 2 }, () => t.state(receipt.threadId, "completed")));
    assert.deepEqual(rows.map(row => row.status).sort(), [200, 409]);
    expect(await t.state(receipt.threadId, "archived", 1), 409);
    assert.equal(expect(await t.thread(receipt.threadId)).thread.management.revision, 2);
  } finally { await t.close(); }
});
