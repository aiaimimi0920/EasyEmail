import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, ok } from "./admin-fixture.mjs";
import { automatic, allocationRuntime, creationCalls } from "./allocation-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";

test("allocation guard and balancing counter are one transaction; failed local writes never dispatch remotely or poison provider health", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  try {
    await h.db.prepare("CREATE TRIGGER fail_allocation_counter BEFORE UPDATE OF allocation_count ON provider_allocation_state BEGIN SELECT RAISE(ABORT,'synthetic allocation counter'); END").run();
    const key = crypto.randomUUID();
    try { assert.equal((await automatic(h, alice.cookie, key)).status, 500); }
    finally { await h.db.prepare("DROP TRIGGER fail_allocation_counter").run(); }
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 0); assert.equal(creationCalls(f).length, 0);
    assert.equal((await allocationRuntime(h)).allocation_count, 0); assert.equal((await allocationRuntime(h)).failure_count, 0);
    ok(await automatic(h, alice.cookie, key), 201);
    assert.equal((await allocationRuntime(h)).allocation_count, 1);
  } finally { await a.close(); }
});

test("a late preflight error reconciles a same-key winner instead of reporting a fresh-allocation failure", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let gate;
  try {
    const key = crypto.randomUUID(), extra = { body: { selection: "automatic", domain: "temp.example.test" } };
    gate = f.hold("/v3/domains"); const first = automatic(h, alice.cookie, key, extra);
    await gate.entered;
    const winner = ok(await automatic(h, alice.cookie, key, extra), 201).mailbox;
    f.modes.set("/v3/domains", 503); gate.release();
    assert.equal(ok(await first).mailbox.id, winner.id);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 1);
    assert.equal((await allocationRuntime(h, "temporam")).allocation_count, 1);
  } finally { gate?.release(); await a.close(); }
});

test("a newer failed probe fences an in-flight successful preflight before acquiring a guard", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let gate;
  try {
    gate = f.hold("/v3/domains");
    const pending = automatic(h, alice.cookie, crypto.randomUUID(), { body: { selection: "automatic", domain: "temp.example.test" } });
    await gate.entered;
    f.modes.set("/v3/domains", 503); ok(await a.probe("temporam")); f.modes.clear();
    gate.release();
    assert.equal((await pending).body.error.code, "provider_cooling");
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 0);
    assert.equal((await allocationRuntime(h, "temporam")).last_error, "provider_unavailable");
  } finally { gate?.release(); await a.close(); }
});

test("an old failed preflight cannot overwrite a newer successful explicit probe", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let gate;
  try {
    gate = f.hold("/v3/domains");
    const pending = automatic(h, alice.cookie, crypto.randomUUID(), { body: { selection: "automatic", domain: "temp.example.test" } });
    await gate.entered; ok(await a.probe("temporam")); f.modes.set("/v3/domains", 503); gate.release();
    assert.equal((await pending).body.error.code, "allocation_unavailable");
    const row = await allocationRuntime(h, "temporam");
    assert.equal(row.cooldown_until, null); assert.equal(row.failure_count, 0); assert.ok(row.last_success_at);
  } finally { gate?.release(); await a.close(); }
});

test("a later-started failed probe still applies after an overlapping older create succeeds first", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let createGate, probeGate;
  try {
    createGate = f.hold("/cf/admin/new_address"); const creating = allocate(h, alice.cookie);
    await createGate.entered;
    probeGate = f.hold("/cf/admin/worker/configs"); const probing = a.probe();
    await probeGate.entered; createGate.release(); ok(await creating, 201);
    f.modes.set("/cf/admin/worker/configs", 503); probeGate.release(); ok(await probing);
    assert.equal((await allocationRuntime(h)).last_error, "provider_unavailable");
  } finally { createGate?.release(); probeGate?.release(); await a.close(); }
});

test("a reserved create may finish but its old success cannot clear a newer failure, and old failures cannot poison revised settings", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let gate;
  try {
    gate = f.hold("/cf/admin/new_address"); const pending = allocate(h, alice.cookie);
    await gate.entered; f.modes.set("/cf/admin/worker/configs", 503); ok(await a.probe()); f.modes.clear(); gate.release();
    ok(await pending, 201);
    assert.equal((await allocationRuntime(h)).last_error, "provider_unavailable");
    ok(await a.save({ domains: ["cf.example.test"] }));
    assert.equal((await h.request("/api/v1/providers", { cookie: alice.cookie })).body.items[0].allocation.state, "ready");
    gate = f.hold("/cf/admin/new_address"); const later = allocate(h, alice.cookie);
    await gate.entered; ok(await a.save({ enabled: false })); f.modes.set("/cf/admin/new_address", 503); gate.release();
    assert.equal((await later).body.creation.state, "unknown");
    assert.equal((await allocationRuntime(h)).config_revision, 1);
    assert.equal((await allocationRuntime(h)).failure_count, 0);
  } finally { gate?.release(); await a.close(); }
});
