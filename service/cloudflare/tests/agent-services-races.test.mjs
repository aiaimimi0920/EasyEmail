import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { selectGates } from "./account-race-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { agentServicesFixture, serviceBody, createService, serviceWrite, getService, expect } from "./agent-services-fixture.mjs";

const entry = new URL("./account-gated-worker.ts", import.meta.url);

test("same-key mutations reconcile receipts after a competing write races the empty receipt snapshot", async () => {
  const gates = await selectGates(); let f, gate, pending;
  try {
    f = await agentServicesFixture(gates.bindings, false, null, entry); const { h, alice } = f;
    for (const [method, different] of [["PATCH", false], ["PATCH", true], ["DELETE", false], ["DELETE", true]]) {
      const id = expect(await createService(h, alice, serviceBody(`${method.toLowerCase()}-${different}@example.test`)), 201).operation.serviceId;
      const key = crypto.randomUUID(), body = { expectedVersion: 1, ...(method === "PATCH" ? { trustLevel: "restricted" } : {}) };
      gate = gates.hold(`service-${method}-${different}`, "agent-service-operation");
      pending = serviceWrite(h, alice, method, id, different ? { ...body, expectedVersion: 2 } : body, key, { headers: gate.headers });
      await gate.entered();
      const first = expect(await serviceWrite(h, alice, method, id, body, key)); gate.release();
      const result = expect(await pending, different ? 409 : 200); pending = null;
      if (different) assert.equal(result.error.code, "idempotency_conflict");
      else { assert.deepEqual(result.operation, first.operation); assert.equal(result.replayed, true); }
      assert.equal(await h.db.prepare("SELECT version FROM agent_services WHERE user_id=? AND id=?").bind(alice.id, id).first("version"), 2);
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await f?.close(); await gates.close(); }
});

test("concurrent CAS and same-key creations have exactly one winner without silent trust overwrite", async () => {
  const gates = await selectGates(); let f, gateA, gateB, a, b;
  try {
    f = await agentServicesFixture(gates.bindings, false, null, entry); const { h, alice } = f;
    const id = expect(await createService(h, alice), 201).operation.serviceId;
    gateA = gates.hold("service-cas-a", "agent-service"); gateB = gates.hold("service-cas-b", "agent-service");
    a = serviceWrite(h, alice, "PATCH", id, { expectedVersion: 1, trustLevel: "trusted" }, crypto.randomUUID(), { headers: gateA.headers });
    b = serviceWrite(h, alice, "PATCH", id, { expectedVersion: 1, trustLevel: "blocked" }, crypto.randomUUID(), { headers: gateB.headers });
    await Promise.all([gateA.entered(), gateB.entered()]); gateA.release(); gateB.release();
    const results = await Promise.all([a, b]); a = b = null;
    assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    const winner = results[0].status === 200 ? "trusted" : "blocked";
    assert.equal(expect(await getService(h, alice, id)).service.trustLevel, winner);
    const key = crypto.randomUUID(), body = serviceBody("concurrent@example.test");
    const same = await Promise.all([createService(h, alice, body, key), createService(h, alice, body, key)]);
    assert.deepEqual(same.map(row => row.status).sort(), [200, 201]);
    assert.equal(same[0].body.operation.serviceId, same[1].body.operation.serviceId);
    const duplicate = await Promise.all([createService(h, alice, serviceBody("different-key@example.test")), createService(h, alice, serviceBody("different-key@example.test"))]);
    assert.deepEqual(duplicate.map(row => row.status).sort(), [201, 409]);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_services WHERE email_address='different-key@example.test'").first("n"), 1);
  } finally { gateA?.release(); gateB?.release(); await a?.catch(() => {}); await b?.catch(() => {}); await f?.close(); await gates.close(); }
});

test("revoked sessions, revoked API keys and disabled users cannot mutate through an earlier authorized snapshot", async () => {
  const gates = await selectGates(); let f, gate, pending;
  try {
    f = await agentServicesFixture(gates.bindings, false, null, entry); const { h, alice } = f;
    const id = expect(await createService(h, alice), 201).operation.serviceId;
    for (const kind of ["key", "user", "session"]) {
      const key = kind === "key" ? await newKey(h, alice.cookie, { scopes: ["agent-services:read", "agent-services:write"] }) : null;
      const operationKey = crypto.randomUUID(); gate = gates.hold(`service-revoke-${kind}`, "agent-service");
      pending = serviceWrite(h, alice, "PATCH", id, { expectedVersion: 1, trustLevel: "trusted" }, operationKey,
        { headers: gate.headers, ...(key ? { token: key.token, origin: null } : {}) });
      await gate.entered();
      if (key) await h.db.prepare("UPDATE api_keys SET revoked_at=unixepoch() WHERE id=?").bind(key.id).run();
      else if (kind === "user") await h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(alice.id).run();
      else {
        const token = alice.cookie.slice(alice.cookie.indexOf("=") + 1), hash = createHash("sha256").update(token).digest("hex");
        await h.db.prepare("UPDATE sessions SET revoked_at=unixepoch() WHERE token_hash=?").bind(hash).run();
      }
      gate.release(); expect(await pending, 401); pending = null;
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_service_operations WHERE request_key=?").bind(operationKey).first("n"), 0);
      assert.equal(await h.db.prepare("SELECT version FROM agent_services WHERE user_id=? AND id=?").bind(alice.id, id).first("version"), 1);
      if (kind === "user") await h.db.prepare("UPDATE users SET status='active' WHERE id=?").bind(alice.id).run();
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await f?.close(); await gates.close(); }
});
