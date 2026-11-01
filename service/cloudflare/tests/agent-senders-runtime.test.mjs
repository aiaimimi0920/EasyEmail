import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { agentSmtpFixture } from "./agent-smtp-fixture.mjs";
import { createService, getService, serviceBody, serviceWrite, expect } from "./agent-services-fixture.mjs";
import { agentWrite, agentAccountInput } from "./agent-accounts-fixture.mjs";

let t, h, alice, bob;
before(async () => { t = await agentSmtpFixture(); ({ h, alice, bob } = t); });
beforeEach(async () => h.resetLimits());
after(async () => t?.close());

test("service sender defaults are private nullable Agent references, persisted and cleared by CAS", async () => {
  const id = expect(await createService(h, alice, serviceBody("default-null@example.test")), 201).operation.serviceId;
  assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, null);
  const key = crypto.randomUUID(), body = { expectedVersion: 1, defaultSenderAccountId: t.id };
  const operation = expect(await serviceWrite(h, alice, "PATCH", id, body, key)).operation;
  assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, t.id);
  const listed = expect(await h.request("/api/v1/agent-services", { cookie: alice.cookie })).items.find(row => row.id === id);
  assert.equal(listed.defaultSenderAccountId, t.id);
  expect(await getService(h, bob, id), 404);
  expect(await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 1, defaultSenderAccountId: null }), 409);
  expect(await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 2, description: "keep the configured sender" }));
  assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, t.id);
  expect(await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 3, defaultSenderAccountId: null }));
  assert.deepEqual(expect(await serviceWrite(h, alice, "PATCH", id, body, key)).operation, operation);
  assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, null);
  await h.restart(); assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, null);
});

test("creating defaults never accepts normal, foreign, missing or deleted accounts and leaves no receipt", async () => {
  const otherId = crypto.randomUUID(); expect(await agentWrite(h, bob, otherId), 201);
  const normalId = crypto.randomUUID();
  await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
    VALUES(?,?,?,'normal','example','hash','normal',0,1,unixepoch(),unixepoch())`).bind(normalId, alice.id, "normal-default@example.test").run();
  for (const accountId of [normalId, otherId, crypto.randomUUID()]) {
    const key = crypto.randomUUID();
    const result = expect(await createService(h, alice, { ...serviceBody(`${key}@example.test`), defaultSenderAccountId: accountId }, key), 409);
    assert.equal(result.error.code, "agent_service_sender_unavailable");
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_service_operations WHERE request_key=?").bind(key).first("n"), 0);
  }
  const removed = crypto.randomUUID(); expect(await agentWrite(h, alice, removed, { ...agentAccountInput, emailAddress: "removed-default@example.test" }), 201);
  await h.db.prepare("UPDATE agent_accounts SET deleted_at=unixepoch(),enabled=0 WHERE id=?").bind(removed).run();
  expect(await createService(h, alice, { ...serviceBody("deleted-default@example.test"), defaultSenderAccountId: removed }), 409);
});

test("default metadata can precede SMTP, disabled defaults remain explicit, and deletion clears only the service mapping", async () => {
  const id = expect(await createService(h, alice, { ...serviceBody("created-default@example.test"), defaultSenderAccountId: t.id }), 201).operation.serviceId;
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_configs WHERE account_id=?").bind(t.id).first("n"), 0);
  await h.db.prepare("UPDATE agent_accounts SET enabled=0 WHERE id=?").bind(t.id).run();
  assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, t.id);
  await h.db.prepare("UPDATE agent_accounts SET enabled=1 WHERE id=?").bind(t.id).run();
  expect(await serviceWrite(h, alice, "DELETE", id, { expectedVersion: 1 }));
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_service_senders WHERE service_id=?").bind(id).first("n"), 0);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_accounts WHERE id=? AND deleted_at IS NULL").bind(t.id).first("n"), 1);
});

test("existing directory scopes control default writes without granting account credentials or task sends", async () => {
  const reader = await newKey(h, alice.cookie, { scopes: ["agent-services:read"] });
  expect(await createService(h, alice, { ...serviceBody("reader-default@example.test"), defaultSenderAccountId: t.id }, undefined, { token: reader.token, origin: null }), 403);
  const manager = await newKey(h, alice.cookie, { scopes: ["agent-services:read", "agent-services:write"] });
  const id = expect(await createService(h, alice, { ...serviceBody("key-default@example.test"), defaultSenderAccountId: t.id }, undefined,
    { token: manager.token, origin: null }), 201).operation.serviceId;
  const serialized = JSON.stringify(expect(await getService(h, alice, id, { token: manager.token, origin: null })));
  assert.equal(serialized.includes("credential"), false); assert.equal(serialized.includes("password"), false);
  expect(await h.request(`/api/v1/agent-accounts/${t.id}`, { token: manager.token, origin: null }), 403);
  expect(await h.request("/api/v1/agent-tasks", { token: manager.token, origin: null }), 403);
});

test("sender input remains strict and setting an identical key cannot overwrite the chosen default", async () => {
  for (const value of ["", "not-a-uuid", 1, {}, [t.id]]) expect(await createService(h, alice, { ...serviceBody(), defaultSenderAccountId: value }), 400);
  const key = crypto.randomUUID(), body = { ...serviceBody("default-replay@example.test"), defaultSenderAccountId: t.id };
  const first = expect(await createService(h, alice, body, key), 201);
  assert.deepEqual(expect(await createService(h, alice, body, key)).operation, first.operation);
  assert.equal(expect(await createService(h, alice, { ...body, defaultSenderAccountId: null }, key), 409).error.code, "idempotency_conflict");
});
