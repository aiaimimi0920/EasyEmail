import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, ok } from "./admin-fixture.mjs";
import { automatic, allocationRuntime, creationCalls } from "./allocation-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("automatic allocation rotates eligible instances, persists the selected provider, and replays its original result across restart", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  try {
    const key = crypto.randomUUID();
    const first = ok(await automatic(h, alice.cookie, key), 201).mailbox;
    const second = ok(await automatic(h, alice.cookie), 201).mailbox;
    assert.equal(first.providerId, "self"); assert.equal(second.providerId, "temporam");
    const row = await h.db.prepare("SELECT provider_id,provider_revision,provider_hash FROM mailbox_creations WHERE mailbox_id=?").bind(first.id).first();
    assert.equal(row.provider_id, first.providerId); assert.equal(row.provider_revision, 0); assert.match(row.provider_hash, /^[0-9a-f]{64}$/);
    const calls = f.calls.length;
    ok(await a.save({ enabled: false })); ok(await a.save({ enabled: false }, "temporam"));
    await h.restart();
    assert.equal(ok(await automatic(h, alice.cookie, key)).mailbox.id, first.id);
    assert.equal(f.calls.length, calls);
    assert.equal((await automatic(h, alice.cookie, key, { body: { selection: "automatic", domain: "temp.example.test" } })).status, 409);
  } finally { await a.close(); }
});

test("automatic requests enforce domain, credentials, scope, Origin and strict input without endpoint or address injection", async () => {
  const a = await adminFixture(), { h, alice, f } = a;
  try {
    for (const body of [{ selection: "automatic", providerId: "self" }, { selection: "random" }, { selection: "automatic", domain: "" },
      { selection: "automatic", domain: "not/a/domain" }, { selection: "automatic", address: "victim@cf.example.test" },
      { selection: "automatic", baseUrl: "https://attacker.test" }, { selection: "automatic", prefix: "victim@cf.example.test" }]) {
      assert.equal((await automatic(h, alice.cookie, crypto.randomUUID(), { body })).status, 400);
    }
    assert.equal(f.calls.length, 0);
    const key = await newKey(h, alice.cookie);
    assert.equal((await automatic(h, null, crypto.randomUUID(), { token: key.token })).status, 403);
    assert.equal((await automatic(h, alice.cookie, crypto.randomUUID(), { origin: null })).status, 403);
    const writer = await newKey(h, alice.cookie, { scopes: ["mailboxes:write"] });
    const filtered = await automatic(h, null, crypto.randomUUID(), { token: writer.token, origin: null, body: { selection: "automatic", domain: "temp.example.test" } });
    assert.equal(ok(filtered, 201).mailbox.providerId, "temporam"); assert.equal(creationCalls(f).length, 0);
    ok(await a.save({}, "self", { secretAction: "clear" }));
    ok(await a.save({ enabled: false }, "temporam"));
    const calls = f.calls.length;
    assert.equal((await automatic(h, alice.cookie)).body.error.code, "allocation_unavailable");
    assert.equal(f.calls.length, calls);
  } finally { await a.close(); }
});

test("an unknown selected write is never retried or replaced; later new allocations avoid cooling and original keys still reconcile", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let gate;
  try {
    const key = crypto.randomUUID(); f.modes.set("/cf/admin/new_address", "invalid");
    gate = f.hold("/cf/admin/new_address"); const first = automatic(h, alice.cookie, key);
    await gate.entered;
    const pending = ok(await automatic(h, alice.cookie, key), 202).creation;
    assert.equal(pending.state, "pending"); assert.equal(pending.providerId, "self"); assert.match(pending.address, /@cf\.example\.test$/);
    gate.release();
    const unknown = ok(await first, 202).creation;
    assert.equal(unknown.state, "unknown"); assert.equal(unknown.providerId, "self"); assert.equal(unknown.address, pending.address);
    const row = await allocationRuntime(h); assert.equal(row.failure_count, 1); assert.equal(row.last_error, "provider_invalid_response");
    assert.ok(row.cooldown_until > Math.floor(Date.now() / 1000));
    const calls = f.calls.length;
    assert.equal((await allocate(h, alice.cookie)).body.error.code, "provider_cooling"); assert.equal(f.calls.length, calls);
    const next = ok(await automatic(h, alice.cookie), 201).mailbox; assert.equal(next.providerId, "temporam");
    await h.restart();
    const before = f.calls.length;
    assert.deepEqual(ok(await automatic(h, alice.cookie, key), 202).creation, unknown);
    assert.equal(f.calls.length, before); assert.equal(creationCalls(f).length, 1);
    const catalog = ok(await h.request("/api/v1/providers", { cookie: alice.cookie }));
    assert.equal(catalog.items.find((item) => item.id === "self").allocation.state, "cooling");
    assert.equal(catalog.items.find((item) => item.id === "self").allocation.cooldownUntil, row.cooldown_until);
    for (const value of ["synthetic-cf-admin", "synthetic-mail-jwt", "baseUrl", "config_hash"]) assert.equal(JSON.stringify(catalog).includes(value), false);
  } finally { gate?.release(); await a.close(); }
});

test("read-only preflight failures cool a provider without acquiring an allocation guard, and an explicit successful probe restores it", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  try {
    f.modes.set("/v3/domains", 429);
    const key = crypto.randomUUID(), body = { selection: "automatic", domain: "temp.example.test" };
    assert.equal((await automatic(h, alice.cookie, key, { body })).body.error.code, "allocation_unavailable");
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 0);
    const state = await allocationRuntime(h, "temporam");
    assert.equal(state.last_error, "provider_rate_limited"); assert.ok(state.cooldown_until - state.last_failure_at >= 2700);
    const before = f.calls.length;
    assert.equal((await automatic(h, alice.cookie, key, { body })).status, 503); assert.equal(f.calls.length, before);
    f.modes.clear(); ok(await a.probe("temporam"));
    assert.equal((await allocationRuntime(h, "temporam")).cooldown_until, null);
    assert.equal(ok(await automatic(h, alice.cookie, key, { body }), 201).mailbox.providerId, "temporam");
    assert.equal((await allocationRuntime(h, "temporam")).allocation_count, 1);
  } finally { await a.close(); }
});
