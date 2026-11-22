import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey, seedMailbox } from "./runtime-harness.mjs";
import { allocate, providerFixture } from "./provider-fixture.mjs";

test("M1 to latest expand preserves users, sessions, keys, mailbox identity and ownership", async () => {
  const h = await createHarness({}, false, "0001_identity.sql");
  try {
    const alice = await h.register("upgrade-alice");
    const bob = await h.register("upgrade-bob");
    const mailbox = await seedMailbox(h, alice.id, "preserved@example.test");
    const key = await newKey(h, alice.cookie);
    const before = await h.db.prepare("SELECT * FROM mailboxes WHERE id = ?").bind(mailbox).first();
    await h.migrate();
    await h.migrate();
    await h.restart();
    const result = await h.request(`/api/v1/mailboxes/${mailbox}`, { token: key.token });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.mailbox.address, before.address);
    assert.equal(result.body.mailbox.createdAt, before.created_at);
    assert.equal(result.body.mailbox.syncedAt, null);
    assert.equal((await h.request("/api/v1/me", { cookie: alice.cookie })).body.user.id, alice.id);
    assert.equal((await h.request(`/api/v1/mailboxes/${mailbox}`, { cookie: bob.cookie })).status, 404);
    console.log(`M1->latest migration evidence: ${h.directory}`);
  } finally { await h.close(); }
});

test("invalid server config/secrets fail before remote write and do not disclose endpoints or credentials", async () => {
  const fixture = await providerFixture();
  const h = await createHarness(fixture.bindings);
  try {
    const alice = await h.register("config-alice");
    const valid = JSON.parse(fixture.bindings.PROVIDER_CONFIG);
    const invalid = ["not-json", JSON.stringify([{ ...valid[0], id: null }]),
      JSON.stringify([{ ...valid[0], baseUrl: "http://attacker.example" }]),
      JSON.stringify([{ ...valid[0], baseUrl: "https://user:password@example.test" }]),
      JSON.stringify([{ ...valid[0], baseUrl: "https://example.test/?key=secret" }]),
      JSON.stringify([{ ...valid[0], domains: ["bad..domain"] }]), JSON.stringify([valid[0], valid[0]])];
    for (const config of invalid) {
      await h.restart({ PROVIDER_CONFIG: config });
      const result = await h.request("/api/v1/providers", { cookie: alice.cookie });
      assert.equal(result.status, 503, result.text);
      assert.equal(result.body.error.code, "provider_config_invalid");
      assert.equal(result.text.includes("password"), false);
    }
    await h.restart({ PROVIDER_CONFIG: fixture.bindings.PROVIDER_CONFIG, PROVIDER_SECRETS: "{}" });
    assert.equal((await allocate(h, alice.cookie)).body.error.code, "provider_secret_unavailable");
    for (const ring of [{}, { active: "constructor", keys: {} }, { keys: { undefined: "a3".repeat(32) } }]) {
      await h.restart({ PROVIDER_SECRETS: fixture.bindings.PROVIDER_SECRETS, MAILBOX_KEYRING: JSON.stringify(ring) });
      assert.equal((await allocate(h, alice.cookie)).body.error.code, "mailbox_vault_unavailable");
    }
    assert.equal(fixture.calls.length, 0);
  } finally { await h.close(); await fixture.close(); }
});
