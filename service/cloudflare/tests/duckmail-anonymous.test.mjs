import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { duckMail, duckmailFixture } from "./duckmail-fixture.mjs";

test("DuckMail public upstream mode is explicit, works without a platform Key and never opens anonymous platform access", async () => {
  const f = await duckmailFixture({ anonymous: true }); let h;
  try {
    h = await createHarness(f.bindings); const alice = await h.register("duck-anonymous-alice");
    const catalog = await h.request("/api/v1/providers", { cookie: alice.cookie }); assert.equal(catalog.body.items[0].allocation.available, true, catalog.text);
    assert.equal((await h.request("/api/v1/providers")).status, 401);
    const result = await h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { selection: "automatic" } });
    assert.equal(result.status, 201, result.text); const mailbox = result.body.mailbox;
    f.messages.set(mailbox.address, [duckMail(f.accounts.get(mailbox.address))]);
    const sync = () => h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} });
    assert.equal((await sync()).body.sync.inserted, 1);
    for (const call of f.calls.filter(call => ["/accounts", "/domains", "/token"].includes(call.path))) assert.equal(call.headers.authorization, undefined);
    await h.restart({ PROVIDER_SECRETS: "not valid secret JSON" });
    assert.equal((await sync()).status, 200, "Explicit anonymous mode does not read or silently fall back to unrelated credentials");
    const count = f.calls.length, keyConfig = { ...f.config }; delete keyConfig.authentication;
    await h.restart({ PROVIDER_CONFIG: JSON.stringify([keyConfig]), PROVIDER_SECRETS: "{}" });
    assert.equal((await h.request("/api/v1/providers", { cookie: alice.cookie })).body.items[0].allocation.available, false);
    assert.equal((await sync()).body.error.code, "provider_secret_unavailable"); assert.equal(f.calls.length, count);
  } finally { await h?.close(); await f.close(); }
});

test("admin anonymous mode is DuckMail-only, persists without fake secret configuration and keeps endpoint identity immutable", async () => {
  const f = await duckmailFixture({ anonymous: true }); let h;
  try {
    h = await createHarness(f.bindings); const admin = await h.register("duck-anonymous-admin");
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    const save = config => h.request("/api/v1/admin/providers/duckmail", { method: "PUT", cookie: admin.cookie,
      body: { expectedRevision: 0, config, secretAction: "keep" } });
    assert.equal((await save({ ...f.config, type: "temporam" })).status, 400);
    assert.equal((await save({ ...f.config, authentication: "fallback-to-anonymous" })).status, 400);
    assert.equal((await save(f.config)).status, 200);
    await h.restart(); const rows = await h.request("/api/v1/admin/providers", { cookie: admin.cookie }), row = rows.body.items[0];
    assert.equal(row.config.authentication, "anonymous"); assert.equal(row.secret.configured, false); assert.equal(row.allocation.available, true);
    const probe = await h.request("/api/v1/admin/providers/duckmail/probe", { method: "POST", cookie: admin.cookie, body: {} });
    assert.equal(probe.status, 200, probe.text); assert.equal(probe.body.health.state, "ok");
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.path === "/domains" && !call.headers.authorization));
    const changed = await h.request("/api/v1/admin/providers/duckmail", { method: "PUT", cookie: admin.cookie,
      body: { expectedRevision: row.revision, config: { ...f.config, baseUrl: `${f.config.baseUrl}/different` }, secretAction: "keep" } });
    assert.equal(changed.body.error.code, "provider_identity_immutable");
    const switchMode = await h.request("/api/v1/admin/providers/duckmail", { method: "PUT", cookie: admin.cookie,
      body: { expectedRevision: row.revision, config: { ...f.config, authentication: "api-key" }, secretAction: "keep" } });
    assert.equal(switchMode.status, 200, switchMode.text);
    const current = (await h.request("/api/v1/admin/providers", { cookie: admin.cookie })).body.items[0];
    assert.equal(current.health.state, "unknown"); assert.equal(current.allocation.available, false);
    const count = f.calls.length, keyProbe = await h.request("/api/v1/admin/providers/duckmail/probe", { method: "POST", cookie: admin.cookie, body: {} });
    assert.equal(keyProbe.body.error.code, "provider_probe_unavailable"); assert.equal(f.calls.length, count);
  } finally { await h?.close(); await f.close(); }
});
