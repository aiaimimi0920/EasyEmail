import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate, providerFixture } from "./provider-fixture.mjs";

let h, fixture, alice, bob;
before(async () => { fixture = await providerFixture(); h = await createHarness(fixture.bindings);
  alice = await h.register("create-alice"); bob = await h.register("create-bob"); });
beforeEach(async () => {
  await h.resetLimits(); fixture.modes.clear();
  await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL,failure_count=0,last_error=NULL,observation_version=operation_sequence+1,operation_sequence=operation_sequence+1").run();
});
after(async () => { await h?.close(); await fixture?.close(); });

test("provider catalog discloses capabilities, not secrets or endpoint configuration", async () => {
  const result = await h.request("/api/v1/providers", { cookie: alice.cookie });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.items[0].capabilities.allocation, "remote-create");
  assert.equal(result.body.items[1].capabilities.allocation, "random-address");
  for (const value of ["synthetic-cf-admin", "synthetic-temporam-key", "baseUrl"]) assert.equal(result.text.includes(value), false);
  const domains = await h.request("/api/v1/providers/temporam/domains", { cookie: alice.cookie });
  assert.deepEqual(domains.body.domains, ["temp.example.test"]);
});

test("Cloudflare creation uses admin route, random 128-bit prefix and encrypted per-mailbox credentials", async () => {
  const result = await allocate(h, alice.cookie);
  assert.equal(result.status, 201, result.text);
  const mailbox = result.body.mailbox;
  assert.match(mailbox.address, /^ee[0-9a-z]{25}@cf\.example\.test$/);
  const row = await h.db.prepare("SELECT * FROM mailboxes WHERE id = ?").bind(mailbox.id).first();
  assert.equal(row.user_id, alice.id);
  assert.equal(row.credential_cipher.includes("synthetic-mail-jwt"), false);
  const envelope = JSON.parse(row.credential_cipher);
  assert.equal(envelope.key, "k1");
  assert.equal(envelope.iv.length, 12);
  assert.equal(result.text.includes("jwt"), false);
  assert.equal(fixture.calls.filter((call) => call.path === "/cf/admin/new_address").length, 1);
});

test("Temporam performs local random allocation, never fabricates upstream POST or address recovery", async () => {
  const start = fixture.calls.length;
  const result = await allocate(h, alice.cookie, "temporam");
  assert.equal(result.status, 201, result.text);
  assert.match(result.body.mailbox.address, /^ee[0-9a-f]{32}@temp\.example\.test$/);
  assert.ok(fixture.calls.slice(start).every((call) => call.method === "GET"));
  for (const extra of [{ address: "victim@temp.example.test" }, { baseUrl: "https://attacker.test" }]) {
    assert.equal((await allocate(h, alice.cookie, "temporam", { body: { providerId: "temporam", domain: "temp.example.test", ...extra } })).status, 400);
  }
  const calls = fixture.calls.length, reservations = (await h.db.prepare('SELECT COUNT(*) n FROM mailbox_creations').first()).n;
  const unsupported = await allocate(h, alice.cookie, 'temporam', { body: { providerId: 'temporam', domain: 'temp.example.test', prefix: 'victim' } });
  assert.equal(unsupported.status, 409); assert.equal(unsupported.body.error.code, 'custom_prefix_unavailable');
  assert.equal(fixture.calls.length, calls);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM mailbox_creations').first()).n, reservations);
});

test("same idempotency key survives restart without another remote create; conflicting payload is rejected", async () => {
  const headers = { "idempotency-key": crypto.randomUUID() };
  const first = await allocate(h, alice.cookie, "self", { headers });
  assert.equal(first.status, 201, first.text);
  const count = fixture.calls.length;
  await h.restart();
  const second = await allocate(h, alice.cookie, "self", { headers });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.mailbox.id, first.body.mailbox.id);
  assert.equal(fixture.calls.length, count);
  assert.equal((await allocate(h, alice.cookie, "temporam", { headers })).status, 409);
  const other = await allocate(h, bob.cookie, "self", { headers });
  assert.equal(other.status, 201, other.text);
  assert.notEqual(other.body.mailbox.id, first.body.mailbox.id);
});

test("concurrent identical creates have one remote writer and expose pending without retrying", async () => {
  const gate = fixture.hold("/cf/admin/new_address");
  const headers = { "idempotency-key": crypto.randomUUID() };
  const pending = allocate(h, alice.cookie, "self", { headers });
  try {
    await gate.entered;
    const second = await allocate(h, alice.cookie, "self", { headers });
    assert.equal(second.status, 202, second.text);
    assert.equal(second.body.creation.state, "pending");
    assert.equal(second.body.creation.retrySafe, false);
  } finally { gate.release(); }
  assert.equal((await pending).status, 201);
});

test("ambiguous response and D1 write failure preserve creation guard instead of duplicating remote resources", async () => {
  const headers = { "idempotency-key": crypto.randomUUID() };
  fixture.modes.set("/cf/admin/new_address", "invalid");
  const unknown = await allocate(h, alice.cookie, "self", { headers });
  assert.equal(unknown.status, 202, unknown.text);
  assert.equal(unknown.body.creation.state, "unknown");
  const count = fixture.calls.length;
  assert.equal((await allocate(h, alice.cookie, "self", { headers })).body.creation.retrySafe, false);
  assert.equal(fixture.calls.length, count);
    fixture.modes.clear();
    // The next branch injects an independent local-storage failure, not a retry of the failed upstream write.
    await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL,observation_version=operation_sequence+1,operation_sequence=operation_sequence+1").run();
  await h.db.prepare(`CREATE TRIGGER fail_mailbox BEFORE INSERT ON mailboxes BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`).run();
  try {
    const failed = await allocate(h, bob.cookie);
    assert.equal(failed.status, 202, failed.text);
    assert.equal(failed.body.creation.state, "unknown");
    const row = await h.db.prepare("SELECT * FROM mailboxes WHERE id = ?").bind(failed.body.creation.mailboxId).first();
    assert.equal(row, null);
  } finally { await h.db.prepare("DROP TRIGGER fail_mailbox").run(); }
});

test("read-only keys do not gain write or message permission; browser writes enforce Origin", async () => {
  const key = await newKey(h, alice.cookie);
  assert.equal((await allocate(h, null, "self", { token: key.token })).status, 403);
  assert.equal((await allocate(h, alice.cookie, "self", { origin: null })).status, 403);
  assert.equal((await allocate(h, alice.cookie, "self", { origin: "https://attacker.test" })).status, 403);
  assert.equal((await allocate(h, alice.cookie, "self", { headers: {} })).status, 400);
  const writer = await newKey(h, bob.cookie, { scopes: ["mailboxes:write"] });
  assert.equal((await allocate(h, null, "self", { token: writer.token, origin: null })).status, 201);
});

test("configured domains are enforced before allocation or remote creation", async () => {
  const count = fixture.calls.length;
  const result = await allocate(h, alice.cookie, "self", { body: { providerId: "self", domain: "attacker.test" } });
  assert.equal(result.status, 400, result.text);
  assert.equal(fixture.calls.length, count);
  console.log(`M2 creation evidence: ${h.directory}`);
});

test("write timeout is unknown and is not repeated even after upstream later completes", { timeout: 25000 }, async () => {
  const gate = fixture.hold("/cf/admin/new_address");
  const headers = { "idempotency-key": crypto.randomUUID() };
  const remoteBefore = fixture.mailboxes.size;
  const pending = allocate(h, alice.cookie, "self", { headers });
  try {
    await gate.entered;
    const result = await pending;
    assert.equal(result.status, 202, result.text);
    assert.equal(result.body.creation.state, "unknown");
    assert.equal(result.body.creation.error, "provider_timeout");
    const count = fixture.calls.length;
    assert.equal((await allocate(h, alice.cookie, "self", { headers })).body.creation.retrySafe, false);
    assert.equal(fixture.calls.length, count);
  } finally { gate.release(); }
  const checked = await allocate(h, alice.cookie, "self", { headers });
  assert.equal(checked.body.creation.state, "unknown");
  assert.equal(fixture.mailboxes.size, remoteBefore + 1);
});
