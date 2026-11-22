import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { agentServicesFixture, serviceBody, createService, serviceWrite, getService, expect } from "./agent-services-fixture.mjs";

let f, h, alice, bob;
before(async () => { f = await agentServicesFixture(); ({ h, alice, bob } = f); });
beforeEach(async () => h.resetLimits());
after(async () => f?.close());

test("private remote-service directory normalizes addresses and preserves independent trust/status metadata", async () => {
  const result = expect(await createService(h, alice, { ...serviceBody(" AGENT@Example.Test ", " 远程服务 "), description: " 本地说明 " }), 201);
  const row = expect(await getService(h, alice, result.operation.serviceId)).service;
  assert.deepEqual(row, { id: result.operation.serviceId, displayName: "远程服务", emailAddress: "agent@example.test", description: "本地说明",
    serviceKind: "email_agent", trustLevel: "unknown", status: "active", version: 1, defaultSenderAccountId: null, createdAt: row.createdAt, updatedAt: row.updatedAt });
  assert.equal(typeof row.createdAt, "number");
  const patch = expect(await serviceWrite(h, alice, "PATCH", row.id, { expectedVersion: 1, trustLevel: "blocked", status: "disabled" }));
  assert.equal(patch.operation.version, 2);
  const changed = expect(await getService(h, alice, row.id)).service;
  assert.equal(changed.trustLevel, "blocked"); assert.equal(changed.status, "disabled");
  expect(await serviceWrite(h, alice, "PATCH", row.id, { expectedVersion: 1, trustLevel: "trusted" }), 409);
  expect(await createService(h, alice, serviceBody("agent@example.test")), 409);
  expect(await createService(h, bob, serviceBody("agent@example.test")), 201);
  expect(await getService(h, bob, row.id), 404);
  expect(await serviceWrite(h, bob, "PATCH", row.id, { expectedVersion: 2, trustLevel: "trusted" }), 404);
  assert.equal(expect(await h.request("/api/v1/mailboxes", { cookie: alice.cookie })).items.length, 0);
  assert.equal(expect(await h.request("/api/v1/normal-accounts", { cookie: alice.cookie })).items.length, 0);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0);
});

test("POST/PATCH/DELETE have durable original-key receipts; replay cannot overwrite newer service state", async () => {
  const key = crypto.randomUUID(), body = serviceBody("receipts@example.test");
  const saved = expect(await createService(h, alice, body, key), 201), id = saved.operation.serviceId;
  assert.equal(expect(await createService(h, alice, body, key)).replayed, true);
  expect(await createService(h, alice, { ...body, trustLevel: "trusted" }, key), 409);
  const patchKey = crypto.randomUUID(), patchBody = { expectedVersion: 1, description: "old result", trustLevel: "restricted" };
  const changed = expect(await serviceWrite(h, alice, "PATCH", id, patchBody, patchKey));
  expect(await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 2, description: "newer result", trustLevel: "blocked" }));
  assert.deepEqual(expect(await serviceWrite(h, alice, "PATCH", id, patchBody, patchKey)).operation, changed.operation);
  assert.equal(expect(await getService(h, alice, id)).service.description, "newer result");
  const deleteKey = crypto.randomUUID(), deletion = expect(await serviceWrite(h, alice, "DELETE", id, { expectedVersion: 3 }, deleteKey));
  expect(await getService(h, alice, id), 404);
  const replacement = expect(await createService(h, alice, body), 201);
  assert.notEqual(replacement.operation.serviceId, id);
  assert.deepEqual(expect(await serviceWrite(h, alice, "DELETE", id, { expectedVersion: 3 }, deleteKey)).operation, deletion.operation);
  expect(await getService(h, alice, replacement.operation.serviceId));
  await h.restart();
  const receipt = expect(await h.request(`/api/v1/agent-service-operations/${key}`, { cookie: alice.cookie })).operation;
  assert.deepEqual(receipt, saved.operation);
  assert.equal(JSON.stringify(receipt).includes(body.emailAddress), false);
  expect(await h.request(`/api/v1/agent-service-operations/${key}`, { cookie: bob.cookie }), 404);
});

test("directory scopes do not grant mail access; API keys can manage services without browser Origin", async () => {
  const unrelated = await newKey(h, alice.cookie, { scopes: ["contacts:read", "contacts:write", "mailboxes:read"] });
  expect(await h.request("/api/v1/agent-services", { token: unrelated.token }), 403);
  const reader = await newKey(h, alice.cookie, { scopes: ["agent-services:read"] });
  expect(await h.request("/api/v1/agent-services", { token: reader.token, origin: null }));
  expect(await createService(h, alice, serviceBody("reader@example.test"), undefined, { token: reader.token, origin: null }), 403);
  const writerOnly = await newKey(h, alice.cookie, { scopes: ["agent-services:write"] });
  expect(await createService(h, alice, serviceBody("writer-only@example.test"), undefined, { token: writerOnly.token, origin: null }), 403);
  const manager = await newKey(h, alice.cookie, { scopes: ["agent-services:read", "agent-services:write"] });
  const created = expect(await createService(h, alice, serviceBody("key@example.test"), undefined, { token: manager.token, origin: null }), 201);
  expect(await h.request(`/api/v1/agent-service-operations/${created.operation.requestKey}`, { token: reader.token }), 403);
  for (const route of ["/api/v1/mailboxes", "/api/v1/contacts", "/api/v1/normal-accounts", "/api/v1/admin/providers"]) {
    expect(await h.request(route, { token: manager.token }), 403);
  }
  expect(await h.request(`/api/v1/api-keys/${manager.id}`, { cookie: alice.cookie, method: "DELETE" }));
  expect(await h.request("/api/v1/agent-services", { token: manager.token }), 401);
});

test("filtered keyset pagination is bounded, complete and tied to owner and filter", async () => {
  for (let i = 0; i < 6; i++) expect(await createService(h, alice, { ...serviceBody(`page-${i}@example.test`, `分页${i}`),
    trustLevel: i < 5 ? "trusted" : "unknown", status: "archived", serviceKind: "research" }), 201);
  const route = "/api/v1/agent-services?limit=2&q=分页&trustLevel=trusted&status=archived&serviceKind=research";
  const first = expect(await h.request(route, { cookie: alice.cookie })); assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = expect(await h.request(`${route}&cursor=${first.nextCursor}`, { cookie: alice.cookie }));
  const third = expect(await h.request(`${route}&cursor=${second.nextCursor}`, { cookie: alice.cookie }));
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(row => row.id)).size, 5);
  expect(await h.request(`${route}&cursor=${first.nextCursor}`, { cookie: bob.cookie }), 400);
  expect(await h.request(`/api/v1/agent-services?limit=2&cursor=${first.nextCursor}`, { cookie: alice.cookie }), 400);
});
