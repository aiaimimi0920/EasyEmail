import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { agentServicesFixture, serviceBody, createService, serviceWrite, getService, expect } from "./agent-services-fixture.mjs";

let f, h, alice;
before(async () => { f = await agentServicesFixture(); ({ h, alice } = f); });
beforeEach(async () => h.resetLimits());
after(async () => f?.close());

test("strict service input rejects injected identity, malformed default account, ambiguous email and invalid enum/control values", async () => {
  for (const fields of [{ userId: alice.id }, { defaultSenderAccountId: "not-a-uuid" }, { parsedPayload: {} }, { trustLevel: "admin" },
    { status: "deleted" }, { emailAddress: "Name <agent@example.test>" }, { emailAddress: "a@example.test,b@example.test" },
    { emailAddress: "agent@example.test\r\nBcc: victim@example.test" }, { displayName: "" }, { displayName: "a".repeat(81) },
    { displayName: "hidden\u202e" }, { description: "x".repeat(2001) }, { description: "x\u0000" }, { serviceKind: "../proxy" }]) {
    const response = await createService(h, alice, { ...serviceBody(), ...fields });
    assert.equal(response.status, 400, response.text);
  }
  const id = expect(await createService(h, alice), 201).operation.serviceId;
  for (const body of [{ expectedVersion: 1 }, { expectedVersion: 0, status: "disabled" }, { expectedVersion: 1.5, status: "disabled" },
    { expectedVersion: 1, emailAddress: "changed@example.test" }, { expectedVersion: 1, userId: "other" }]) {
    expect(await serviceWrite(h, alice, "PATCH", id, body), 400);
  }
  assert.equal(expect(await getService(h, alice, id)).service.version, 1);
});

test("method, filter, body, idempotency and same-origin gates cannot reserve a service", async () => {
  const before = await h.db.prepare("SELECT COUNT(*) n FROM agent_service_operations").first("n");
  expect(await createService(h, alice, serviceBody(), "short"), 400);
  expect(await createService(h, alice, serviceBody(), undefined, { origin: null }), 403);
  expect(await createService(h, alice, serviceBody(), undefined, { origin: "https://attacker.example.test" }), 403);
  expect(await createService(h, alice, serviceBody(), undefined, { headers: { "content-type": "text/plain" } }), 415);
  expect(await createService(h, alice, { ...serviceBody(), description: "x".repeat(9000) }), 413);
  for (const query of ["userId=other", "q=x&q=y", "limit=0", "limit=101", "trustLevel=admin", "status=deleted", "cursor=invalid", "q=%00"]) {
    expect(await h.request(`/api/v1/agent-services?${query}`, { cookie: alice.cookie }), 400);
  }
  expect(await h.request("/api/v1/agent-services", { cookie: alice.cookie, method: "PUT", body: {} }), 405);
  expect(await h.request("/api/v1/agent-services/not-a-uuid", { cookie: alice.cookie }), 404);
  expect(await h.request(`/api/v1/agent-service-operations/${crypto.randomUUID()}?q=x`, { cookie: alice.cookie }), 400);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_service_operations").first("n"), before);
});

test("every mutation and receipt completion rolls back together on an actual D1 transaction failure", async () => {
  const id = expect(await createService(h, alice, serviceBody("rollback@example.test")), 201).operation.serviceId;
  await h.db.prepare("CREATE TRIGGER agent_receipt_failure BEFORE UPDATE OF completed_at ON agent_service_operations BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END").run();
  try {
    for (const [method, target, body] of [["POST", null, serviceBody("not-created@example.test")],
      ["PATCH", id, { expectedVersion: 1, trustLevel: "trusted" }], ["DELETE", id, { expectedVersion: 1 }]]) {
      const key = crypto.randomUUID(), result = await serviceWrite(h, alice, method, target, body, key);
      expect(result, 503); assert.equal(result.body.error.code, "agent_service_storage_failed");
      assert.equal(result.text.includes("private synthetic failure"), false);
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_service_operations WHERE request_key=?").bind(key).first("n"), 0);
      assert.equal(expect(await getService(h, alice, id)).service.version, 1);
    }
  } finally { await h.db.prepare("DROP TRIGGER agent_receipt_failure").run(); }
});

test("bounded lifetime services and durable receipt quotas cannot be bypassed by deleting or retrying", async () => {
  const original = expect(await createService(h, alice, serviceBody("quota@example.test")), 201), id = original.operation.serviceId;
  const count = await h.db.prepare("SELECT COUNT(*) n FROM agent_services WHERE user_id=?").bind(alice.id).first("n");
  await h.db.batch(Array.from({ length: 256 - count }, (_, i) => h.db.prepare(`INSERT INTO agent_services
    (user_id,id,display_name,email_address,service_kind,trust_level,status,version,created_at,updated_at,deleted_at)
    VALUES(?,?,'','','email_agent','blocked','archived',1,0,0,0)`).bind(alice.id, crypto.randomUUID())));
  const full = await createService(h, alice, serviceBody("overflow@example.test")); expect(full, 409);
  assert.equal(full.body.error.code, "agent_service_limit");
  expect(await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 1, trustLevel: "restricted" }));
  const ops = await h.db.prepare("SELECT COUNT(*) n FROM agent_service_operations WHERE user_id=?").bind(alice.id).first("n");
  for (let start = ops; start < 10000; start += 100) {
    await h.db.batch(Array.from({ length: Math.min(100, 10000 - start) }, () => h.db.prepare(`INSERT INTO agent_service_operations
      (user_id,request_key,id,request_hash,kind,service_id,version,deleted,created_at,completed_at) VALUES(?,?,?,'synthetic','POST',?,1,0,0,0)`)
      .bind(alice.id, crypto.randomUUID(), crypto.randomUUID(), id)));
  }
  const limited = await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 2, status: "disabled" });
  expect(limited, 409); assert.equal(limited.body.error.code, "agent_service_operation_limit");
  const replay = expect(await createService(h, alice, serviceBody("quota@example.test"), original.operation.requestKey));
  assert.equal(replay.replayed, true); assert.equal(expect(await getService(h, alice, id)).service.version, 2);
});
