import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, ok } from "./admin-fixture.mjs";
import { automatic, allocationRuntime, creationCalls } from "./allocation-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";
import { retentionFixture } from "./retention-fixture.mjs";

test("automatic selection may skip timed-out read-only preflight, but dispatches exactly one selected create", { timeout: 30000 }, async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let gate;
  try {
    ok(await a.probe());
    await h.db.prepare("UPDATE provider_allocation_state SET allocation_count=10 WHERE provider_id='self'").run();
    gate = f.hold("/v3/domains");
    const pending = automatic(h, alice.cookie);
    await gate.entered;
    const box = ok(await pending, 201).mailbox;
    assert.equal(box.providerId, "self"); assert.equal(creationCalls(f).length, 1);
    const row = await allocationRuntime(h, "temporam"); assert.equal(row.last_error, "provider_timeout");
    assert.ok(row.cooldown_until - row.last_failure_at >= 900);
    gate.release();
    await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=unixepoch()-1 WHERE provider_id='temporam'").run();
    assert.equal(ok(await automatic(h, alice.cookie, crypto.randomUUID(), { body: { selection: "automatic", domain: "temp.example.test" } }), 201).mailbox.providerId, "temporam");
    assert.equal((await allocationRuntime(h, "temporam")).failure_count, 0);
  } finally { gate?.release(); await a.close(); }
});

test("mailbox-scoped authentication failures do not poison the global allocation gate or switch an existing mailbox", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  try {
    const box = ok(await allocate(h, alice.cookie), 201).mailbox;
    f.modes.set("/cf/api/parsed_mails", 401);
    const failed = await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} });
    assert.equal(failed.body.error.code, "provider_auth_failed");
    assert.equal((await allocationRuntime(h)).cooldown_until, null);
    ok(await allocate(h, alice.cookie), 201);
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}`, { cookie: alice.cookie })).body.mailbox.address, box.address);
    assert.equal(f.calls.some((call) => call.path.startsWith("/v3")), false);
  } finally { await a.close(); }
});

test("automatic allocations share retention snapshots, atomic quota and ownership guards", async () => {
  const a = await retentionFixture(), { h, alice } = a;
  try {
    ok(await a.policy({ enabled: true, mailboxDays: 1 }));
    const box = ok(await automatic(h, alice.cookie), 201).mailbox;
    assert.equal(box.expiresAt, box.createdAt + 86400);
    const guard = await h.db.prepare("SELECT * FROM mailbox_creations WHERE mailbox_id=?").bind(box.id).first();
    assert.equal(guard.policy_revision, 1); assert.equal(guard.expires_at, box.expiresAt); assert.equal(guard.provider_id, box.providerId);
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}`, { cookie: a.admin.cookie })).status, 404);
  } finally { await a.close(); }
});
