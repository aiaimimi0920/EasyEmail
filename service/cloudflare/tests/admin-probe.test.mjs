import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, ok } from "./admin-fixture.mjs";

test("explicit probes bound upstream errors, redirects and response sizes; no raw body or automatic retries", async () => {
  const a = await adminFixture(), { h, f } = a;
  try {
    for (const [mode, code] of [[401, "provider_auth_failed"], [429, "provider_rate_limited"], [500, "provider_unavailable"],
      ["redirect", "provider_unavailable"], ["invalid", "provider_invalid_response"], ["oversized", "provider_response_too_large"], ["disconnect", "provider_invalid_response"]]) {
      await h.resetLimits(); f.modes.set("/cf/admin/worker/configs", mode);
      const calls = f.calls.length, response = await a.probe();
      ok(response); assert.equal(response.body.health.state, "error"); assert.equal(response.body.health.error, code);
      assert.equal(response.text.includes("do-not-leak"), false); assert.equal(f.calls.length, calls + 1);
      assert.equal((await a.current()).health.error, code);
    }
    assert.equal(f.calls.some((row) => row.path === "/secret-exfiltration"), false);
    f.modes.clear(); await h.resetLimits();
    for (let i = 0; i < 3; i++) ok(await a.probe());
    const calls = f.calls.length;
    assert.equal((await a.probe()).status, 429); assert.equal(f.calls.length, calls);
  } finally { await a.close(); }
});

test("probe uses a finite deadline, stores only a safe timeout code and validates configured domains", { timeout: 40000 }, async () => {
  const a = await adminFixture(), { h, f } = a;
  let gate;
  try {
    gate = f.hold("/cf/admin/worker/configs");
    const pending = a.probe(); await gate.entered;
    try { assert.equal(ok(await pending).health.error, "provider_timeout"); }
    finally { gate.release(); }
    ok(await a.save({ domains: ["other.example.test"] }));
    assert.equal((await a.current()).health.state, "unknown");
    assert.equal(ok(await a.probe()).health.error, "provider_domains_mismatch");
    const audit = ok(await h.request("/api/v1/admin/audit?limit=1", { cookie: a.admin.cookie }));
    assert.equal(audit.items.length, 1); assert.ok(audit.nextCursor);
    const next = ok(await h.request(`/api/v1/admin/audit?limit=1&cursor=${audit.nextCursor}`, { cookie: a.admin.cookie }));
    assert.notEqual(next.items[0].id, audit.items[0].id);
  } finally { gate?.release(); await a.close(); }
});

test("environment-only metadata changes invalidate stored health even without an override revision", async () => {
  const a = await adminFixture(), { h, f } = a;
  try {
    ok(await a.probe()); assert.equal((await a.current()).health.state, "ok");
    const baseline = JSON.parse(f.bindings.PROVIDER_CONFIG);
    baseline[0].domains = ["changed.example.test"];
    await h.restart({ PROVIDER_CONFIG: JSON.stringify(baseline) });
    assert.equal((await a.current()).revision, 0); assert.equal((await a.current()).health.state, "unknown");
    await h.db.prepare("ALTER TABLE provider_overrides RENAME TO unavailable_provider_overrides").run();
    const calls = f.calls.length;
    assert.equal((await h.request("/api/v1/providers", { cookie: a.alice.cookie })).status, 500);
    assert.equal(f.calls.length, calls, "Database failure must not fall back to deployment credentials");
  } finally { await a.close(); }
});
