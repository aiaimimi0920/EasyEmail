import assert from "node:assert/strict";
import { test } from "node:test";
import { selectGates } from "./account-race-fixture.mjs";
import { agentSmtpFixture } from "./agent-smtp-fixture.mjs";
import { createService, getService, serviceBody, serviceWrite, expect } from "./agent-services-fixture.mjs";

test("sender deleted after a service snapshot cannot be newly assigned and no partial receipt remains", async () => {
  const gates = await selectGates(); let t, gate, pending;
  try {
    t = await agentSmtpFixture({ bindings: gates.bindings, entry: new URL("./account-gated-worker.ts", import.meta.url) });
    const { h, alice } = t, id = expect(await createService(h, alice), 201).operation.serviceId, key = crypto.randomUUID();
    gate = gates.hold("default-sender-late-delete", "agent-service");
    pending = serviceWrite(h, alice, "PATCH", id, { expectedVersion: 1, defaultSenderAccountId: t.id }, key, { headers: gate.headers });
    await gate.entered(); await h.db.prepare("UPDATE agent_accounts SET deleted_at=unixepoch(),enabled=0 WHERE id=?").bind(t.id).run(); gate.release();
    assert.equal(expect(await pending, 409).error.code, "agent_service_sender_unavailable"); pending = null;
    assert.equal(expect(await getService(h, alice, id)).service.version, 1);
    assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, null);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_service_operations WHERE request_key=?").bind(key).first("n"), 0);
  } finally { gate?.release(); await pending?.catch(() => {}); await t?.close(); await gates.close(); }
});

test("default mapping and directory version share a CAS transaction, including rollback on mapping failure", async () => {
  const t = await agentSmtpFixture(), { h, alice } = t;
  try {
    const id = expect(await createService(h, alice, serviceBody("default-atomic@example.test")), 201).operation.serviceId;
    await h.db.prepare("CREATE TRIGGER test_default_failure BEFORE INSERT ON agent_service_senders BEGIN SELECT RAISE(ABORT,'synthetic-default-failure'); END").run();
    const key = crypto.randomUUID(), body = { expectedVersion: 1, defaultSenderAccountId: t.id };
    assert.equal(expect(await serviceWrite(h, alice, "PATCH", id, body, key), 503).error.code, "agent_service_storage_failed");
    assert.equal(expect(await getService(h, alice, id)).service.version, 1);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_service_operations WHERE request_key=?").bind(key).first("n"), 0);
    await h.db.prepare("DROP TRIGGER test_default_failure").run();
    const results = await Promise.all([serviceWrite(h, alice, "PATCH", id, body, key), serviceWrite(h, alice, "PATCH", id, body, key)]);
    assert.deepEqual(results.map(row => row.status), [200, 200]);
    assert.deepEqual(results[0].body.operation, results[1].body.operation);
    assert.equal(expect(await getService(h, alice, id)).service.version, 2);
    assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, t.id);
    const competing = await Promise.all([
      serviceWrite(h, alice, "PATCH", id, { expectedVersion: 2, defaultSenderAccountId: null }),
      serviceWrite(h, alice, "PATCH", id, { expectedVersion: 2, description: "preserve default" }),
    ]);
    assert.deepEqual(competing.map(row => row.status).sort(), [200, 409]);
    const current = expect(await getService(h, alice, id)).service;
    assert.equal(current.defaultSenderAccountId, competing[0].status === 200 ? null : t.id);
    assert.equal(current.version, 3);
  } finally { await t.close(); }
});
