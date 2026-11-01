import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { adminFixture, ok } from "./admin-fixture.mjs";

test("admin membership is live, session-only, origin guarded, and never granted by registration order", async () => {
  const a = await adminFixture(), { h, admin, alice } = a;
  try {
    assert.equal((await h.request("/api/v1/me", { cookie: alice.cookie })).body.user.isAdmin, false);
    const key = await newKey(h, admin.cookie);
    for (const path of ["providers", "overview", "audit", "providers/self/probe"]) {
      const options = path.endsWith("probe") ? { method: "POST", body: {} } : {};
      assert.equal((await h.request(`/api/v1/admin/${path}`, { token: key.token, ...options })).status, 403);
      assert.equal((await h.request(`/api/v1/admin/${path}`, { cookie: alice.cookie, ...options })).status, 403);
    }
    assert.equal((await h.request("/api/v1/admin/providers/self/probe", { cookie: admin.cookie, method: "POST", body: {}, origin: "https://attacker.test" })).status, 403);
    await h.db.prepare("DELETE FROM platform_admins WHERE user_id = ?").bind(admin.id).run();
    assert.equal((await a.list()).status, 403);
    assert.equal((await h.request("/api/v1/me", { cookie: admin.cookie })).body.user.isAdmin, false);
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    await h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(admin.id).run();
    assert.equal((await a.list()).status, 401);
  } finally { await a.close(); }
});

test("new endpoints require operator origins; saved identities cannot redirect existing credentials", async () => {
  const a = await adminFixture(), { h, f } = a;
  try {
    const original = (await a.current()).config;
    const next = { ...original, id: "second", baseUrl: "https://untrusted.example.test/api" };
    assert.equal((await a.save(next, "second")).body.error.code, "provider_endpoint_denied");
    for (const changes of [{ baseUrl: `${original.baseUrl}/other` }, { type: "temporam", sendTransport: undefined, sendRecipients: [] }]) {
      assert.equal((await a.save(changes)).body.error.code, "provider_identity_immutable");
    }
    await h.restart({ PROVIDER_ENDPOINT_ORIGINS: JSON.stringify(["https://trusted.example.test"]) });
    ok(await a.save({ ...next, baseUrl: "https://trusted.example.test/api", enabled: false }, "second"));
    assert.equal((await a.current("second")).secret.configured, false);
    ok(await a.save({ enabled: false }));
    const baseline = JSON.parse(f.bindings.PROVIDER_CONFIG);
    baseline[0].baseUrl += "/changed-by-deployment";
    await h.restart({ PROVIDER_CONFIG: JSON.stringify(baseline) });
    assert.equal((await a.list()).body.error.code, "provider_identity_conflict");
    assert.equal(f.calls.length, 0);
  } finally { await a.close(); }
});

test("admin writes reject malformed, unknown, injected or oversized fields without audit or provider calls", async () => {
  const a = await adminFixture(), { h, f, admin } = a;
  try {
    const config = (await a.current()).config;
    const valid = { expectedRevision: 0, config, secretAction: "keep" };
    for (const change of [{ expectedRevision: -1 }, { expectedRevision: 0.5 }, { secretAction: "delete" }, { unknown: true },
      { secret: { apiKey: "hidden" } }, { config: { ...config, enabled: "yes" } }, { config: { ...config, revision: 0 } },
      { config: { ...config, domains: ["bad..domain"] } }, { config: { ...config, sendRecipients: ["*", "victim@example.test"] } },
      { secretAction: "replace", secret: { apiKey: "injected\r\nHeader: value" } },
      { secretAction: "replace", secret: { apiKey: "valid", unauthorized: "hidden" } }]) {
      assert.equal((await h.request("/api/v1/admin/providers/self", { cookie: admin.cookie, method: "PUT", body: { ...valid, ...change } })).status, 400);
    }
    assert.equal((await h.request("/api/v1/admin/providers/self", { cookie: admin.cookie, method: "PUT", body: "x".repeat(8193) })).status, 413);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM admin_audit").first()).n, 0);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM provider_overrides").first()).n, 0);
    assert.equal(f.calls.length, 0);
  } finally { await a.close(); }
});

test("provider secrets are domain separated across endpoints and mailbox envelopes and support deployment key rotation", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  try {
    const config = (await a.current()).config;
    const secret = { apiKey: "synthetic-cf-admin", sitePassword: "synthetic-site-password" };
    ok(await a.save({}, "self", { secretAction: "replace", secret }));
    const first = await h.db.prepare("SELECT * FROM provider_overrides WHERE id = 'self'").first();
    ok(await a.save({ ...config, id: "secondary" }, "secondary", { secretAction: "replace", secret }));
    await h.db.prepare("UPDATE provider_overrides SET secret_cipher = ? WHERE id = 'secondary'").bind(first.secret_cipher).run();
    assert.equal((await allocate(h, alice.cookie, "secondary", { body: { providerId: "secondary", domain: "cf.example.test" } })).body.error.code, "provider_secret_unavailable");
    const box = ok(await allocate(h, alice.cookie), 201).mailbox;
    const mailboxCipher = (await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id = ?").bind(box.id).first()).credential_cipher;
    await h.db.prepare("UPDATE provider_overrides SET secret_cipher = ? WHERE id = 'self'").bind(mailboxCipher).run();
    const calls = f.calls.length;
    assert.equal((await allocate(h, alice.cookie)).body.error.code, "provider_secret_unavailable");
    assert.equal(f.calls.length, calls);
    await h.db.prepare("UPDATE provider_overrides SET secret_cipher = ? WHERE id = 'self'").bind(first.secret_cipher).run();
    await h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k1: "a3".repeat(32), k2: "b4".repeat(32) } }) });
    ok(await a.probe());
    ok(await a.save({}, "self", { secretAction: "replace", secret }));
    const rotated = await h.db.prepare("SELECT secret_cipher FROM provider_overrides WHERE id = 'self'").first();
    assert.equal(JSON.parse(rotated.secret_cipher).key, "k2");
    await h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k2: "b4".repeat(32) } }) });
    ok(await a.probe());
  } finally { await a.close(); }
});
