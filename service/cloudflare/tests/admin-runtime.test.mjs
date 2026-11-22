import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate, providerFixture } from "./provider-fixture.mjs";

let h, f, alice, admin;
const save = (id, body, extra = {}) => h.request(`/api/v1/admin/providers/${id}`, { method: "PUT", cookie: admin.cookie, body, ...extra });
const listing = () => h.request("/api/v1/admin/providers", { cookie: admin.cookie });
before(async () => { f = await providerFixture(); h = await createHarness(f.bindings);
  alice = await h.register("admin-ordinary-alice"); admin = await h.register("admin-operator"); });
beforeEach(async () => h.resetLimits());
after(async () => { await h?.close(); await f?.close(); });

test("admin control plane denies ordinary sessions and every API key, including keys owned by an administrator", async () => {
  assert.equal((await h.request("/api/v1/admin/providers", { cookie: alice.cookie })).status, 403);
  await h.db.prepare("INSERT INTO platform_admins(user_id,created_at) VALUES (?,unixepoch())").bind(admin.id).run();
  const key = await newKey(h, admin.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:send"] });
  assert.equal((await h.request("/api/v1/admin/providers", { token: key.token })).status, 403);
  assert.equal((await h.request("/api/v1/me", { cookie: admin.cookie })).body.user.isAdmin, true);
  assert.equal((await h.request("/api/v1/me", { token: key.token })).body.user.isAdmin, false);
  const list = await listing(); assert.equal(list.status, 200, list.text);
  for (const secret of ["synthetic-cf-admin", "synthetic-site-password", "synthetic-temporam-key", "cipher"]) assert.equal(list.text.includes(secret), false);
});

test("revisioned provider/domain settings persist and affect real allocation without mutating immutable endpoint identity", async () => {
  const initial = (await listing()).body.items.find((item) => item.config.id === "self");
  const body = { expectedRevision: 0, config: { ...initial.config, enabled: false }, secretAction: "keep" };
  assert.equal((await save("self", body, { origin: null })).status, 403);
  assert.equal((await save("self", body)).status, 200);
  const calls = f.calls.length;
  assert.equal((await allocate(h, alice.cookie)).body.error.code, "provider_disabled");
  assert.equal(f.calls.length, calls);
  assert.equal((await save("self", body)).status, 409);
  assert.equal((await save("self", { ...body, expectedRevision: 1, config: { ...initial.config, baseUrl: "https://attacker.example.test" } })).body.error.code, "provider_identity_immutable");
  const enabled = await save("self", { ...body, expectedRevision: 1, config: { ...initial.config, domains: ["other.example.test"], enabled: true } });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal((await allocate(h, alice.cookie)).body.error.code, "domain_unavailable");
  await h.restart();
  const current = (await listing()).body.items.find((item) => item.config.id === "self");
  assert.equal(current.revision, 2); assert.deepEqual(current.config.domains, ["other.example.test"]);
  const restore = await save("self", { expectedRevision: 2, config: initial.config, secretAction: "keep" });
  assert.equal(restore.status, 200); assert.equal((await allocate(h, alice.cookie)).status, 201);
});

test("provider secrets are write-only encrypted values; clear never silently falls back to environment credentials", async () => {
  let current = (await listing()).body.items.find((item) => item.config.id === "self");
  const secret = { apiKey: "synthetic-cf-admin", sitePassword: "synthetic-site-password" };
  let result = await save("self", { expectedRevision: current.revision, config: current.config, secretAction: "replace", secret });
  assert.equal(result.status, 200, result.text); assert.equal(result.text.includes(secret.apiKey), false);
  const row = await h.db.prepare("SELECT * FROM provider_overrides WHERE id = 'self'").first();
  assert.equal(row.secret_cipher.includes(secret.apiKey), false); assert.equal(row.secret_source, "stored");
  await h.restart(); assert.equal((await allocate(h, alice.cookie)).status, 201);
  current = (await listing()).body.items.find((item) => item.config.id === "self");
  result = await save("self", { expectedRevision: current.revision, config: current.config, secretAction: "clear" });
  assert.equal(result.status, 200);
  const calls = f.calls.length;
  assert.equal((await allocate(h, alice.cookie)).body.error.code, "provider_secret_unavailable"); assert.equal(f.calls.length, calls);
  current = (await listing()).body.items.find((item) => item.config.id === "self");
  assert.equal((await save("self", { expectedRevision: current.revision, config: current.config, secretAction: "replace", secret })).status, 200);
});

test("explicit probes validate authenticated provider contracts, persist status and never disclose response bodies", async () => {
  const probe = (id) => h.request(`/api/v1/admin/providers/${id}/probe`, { method: "POST", cookie: admin.cookie, body: {} });
  const calls = f.calls.length;
  assert.equal((await listing()).status, 200); assert.equal(f.calls.length, calls);
  const result = await probe("self"); assert.equal(result.status, 200, result.text); assert.equal(result.body.health.state, "ok");
  assert.equal(f.calls.at(-1).path, "/cf/admin/worker/configs"); assert.equal(f.calls.at(-1).method, "GET");
  f.modes.set("/cf/admin/worker/configs", 401);
  try {
    const failed = await probe("self"); assert.equal(failed.body.health.state, "error");
    assert.equal(failed.body.health.error, "provider_auth_failed"); assert.equal(failed.text.includes("do-not-leak"), false);
  } finally { f.modes.clear(); }
  assert.equal((await probe("temporam")).body.health.state, "ok");
  const audit = await h.request("/api/v1/admin/audit", { cookie: admin.cookie });
  assert.ok(audit.body.items.length > 0);
  for (const value of ["synthetic-cf-admin", "secret_cipher", "sitePassword", "do-not-leak"]) assert.equal(audit.text.includes(value), false);
  assert.equal((await h.request("/api/v1/admin/overview", { cookie: admin.cookie })).body.counts.users, 2);
});
