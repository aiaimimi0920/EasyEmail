import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { selectGates } from "./account-race-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { agentAccountsFixture, agentWrite, agentDelete, agentAccountInput as input, expect } from "./agent-accounts-fixture.mjs";

const entry = new URL("./account-gated-worker.ts", import.meta.url);
test("Agent original-key races reconcile completion without replay overwrites or incompatible requests", async () => {
  const gates = await selectGates(); let t, gate, pending;
  try {
    t = await agentAccountsFixture(gates.bindings, entry); const { h, alice } = t;
    for (const deleting of [false, true]) for (const different of [false, true]) {
      const id = crypto.randomUUID(), body = { ...input, emailAddress: `race-${deleting}-${different}@example.test` };
      expect(await agentWrite(h, alice, id, body), 201);
      const key = crypto.randomUUID(), command = deleting ? { expectedRevision: different ? 2 : 1 } : { ...body, expectedRevision: different ? 2 : 1, enabled: false };
      gate = gates.hold(`account-op-${deleting}-${different}`, "agent-account-operation");
      pending = h.request(`/api/v1/agent-accounts/${id}`, { method: deleting ? "DELETE" : "PUT", cookie: alice.cookie,
        headers: { "idempotency-key": key, ...gate.headers }, body: command }); await gate.entered();
      const first = deleting ? await agentDelete(h, alice, id, 1, key) : await agentWrite(h, alice, id, { ...body, expectedRevision: 1, enabled: false }, key);
      expect(first); gate.release(); const result = expect(await pending, different ? 409 : 200); pending = null;
      if (different) assert.equal(result.error.code, "idempotency_conflict"); else assert.deepEqual(result.operation, first.body.operation);
      assert.equal(await h.db.prepare("SELECT revision FROM agent_accounts WHERE id=?").bind(id).first("revision"), 2);
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await t?.close(); await gates.close(); }
});

test("Agent CAS has one winner and concurrent same-key or duplicate-address creations are atomic", async () => {
  const gates = await selectGates(); let t, ga, gb, a, b;
  try {
    t = await agentAccountsFixture(gates.bindings, entry); const { h, alice } = t;
    const id = crypto.randomUUID(); expect(await agentWrite(h, alice, id), 201);
    ga = gates.hold("agent-account-cas-a", "agent-account"); gb = gates.hold("agent-account-cas-b", "agent-account");
    a = agentWrite(h, alice, id, { ...input, expectedRevision: 1, displayName: "A" }, undefined, { headers: ga.headers });
    b = agentWrite(h, alice, id, { ...input, expectedRevision: 1, displayName: "B" }, undefined, { headers: gb.headers });
    await Promise.all([ga.entered(), gb.entered()]); ga.release(); gb.release();
    const cas = await Promise.all([a, b]); a = b = null; assert.deepEqual(cas.map(r => r.status).sort(), [200, 409]);
    const row = await h.db.prepare("SELECT display_name,revision FROM agent_accounts WHERE id=?").bind(id).first();
    assert.equal(row.display_name, cas[0].status === 200 ? "A" : "B"); assert.equal(row.revision, 2);
    const newId = crypto.randomUUID(), key = crypto.randomUUID(), body = { ...input, emailAddress: "same-key@example.test" };
    const same = await Promise.all([agentWrite(h, alice, newId, body, key), agentWrite(h, alice, newId, body, key)]);
    assert.deepEqual(same.map(r => r.status).sort(), [200, 201]); assert.deepEqual(same[0].body.operation, same[1].body.operation);
    const duplicate = await Promise.all([agentWrite(h, alice, crypto.randomUUID(), { ...input, emailAddress: "duplicate@example.test" }),
      agentWrite(h, alice, crypto.randomUUID(), { ...input, emailAddress: "duplicate@example.test" })]);
    assert.deepEqual(duplicate.map(r => r.status).sort(), [201, 409]);
  } finally { ga?.release(); gb?.release(); await a?.catch(() => {}); await b?.catch(() => {}); await t?.close(); await gates.close(); }
});

test("Agent reservation rechecks revoked/expired credentials and disabled users after authorization snapshot", async () => {
  const gates = await selectGates(); let t, gate, pending;
  try {
    t = await agentAccountsFixture(gates.bindings, entry); const { h, alice } = t;
    const id = crypto.randomUUID(); expect(await agentWrite(h, alice, id), 201);
    for (const kind of ["key", "expiry", "user", "session"]) {
      const key = ["key", "expiry"].includes(kind) ? await newKey(h, alice.cookie, { scopes: ["agent-accounts:read", "agent-accounts:write"] }) : null;
      const op = crypto.randomUUID(); gate = gates.hold(`agent-account-revoke-${kind}`, "agent-account");
      pending = agentWrite(h, alice, id, { ...input, expectedRevision: 1, displayName: "must not commit" }, op,
        { headers: gate.headers, ...(key ? { token: key.token, origin: null } : {}) }); await gate.entered();
      if (key) await h.db.prepare(kind === "expiry" ? "UPDATE api_keys SET expires_at=0 WHERE id=?" : "UPDATE api_keys SET revoked_at=unixepoch() WHERE id=?").bind(key.id).run();
      else if (kind === "user") await h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(alice.id).run();
      else await h.db.prepare("UPDATE sessions SET revoked_at=unixepoch() WHERE token_hash=?")
        .bind(createHash("sha256").update(alice.cookie.split("=")[1]).digest("hex")).run();
      gate.release(); expect(await pending, 401); pending = null;
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_account_operations WHERE request_key=?").bind(op).first("n"), 0);
      assert.equal(await h.db.prepare("SELECT revision FROM agent_accounts WHERE id=?").bind(id).first("revision"), 1);
      if (kind === "user") await h.db.prepare("UPDATE users SET status='active' WHERE id=?").bind(alice.id).run();
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await t?.close(); await gates.close(); }
});
