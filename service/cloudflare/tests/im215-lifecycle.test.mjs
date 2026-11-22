import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { build } from "esbuild";
import { createHarness } from "./runtime-harness.mjs";
import { im215Fixture, im215Mail } from "./im215-fixture.mjs";

let h, f, alice, admin;
const allocate = async (extra = {}) => {
  await h.resetLimits(); await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='im215'").run();
  return h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { providerId: "im215", domain: "im215.example.test" }, ...extra });
};
const sync = (box, page = 1) => h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: alice.cookie, body: { page } });
const policy = async value => {
  const current = (await h.request("/api/v1/admin/retention", { cookie: admin.cookie })).body;
  const result = await h.request("/api/v1/admin/retention", { method: "PUT", cookie: admin.cookie,
    body: { expectedRevision: current.revision, policy: { ...current.policy, ...value }, confirm: "APPLY RETENTION" } });
  assert.equal(result.status, 200, result.text);
};
before(async () => {
  f = await im215Fixture(); h = await createHarness(f.bindings); alice = await h.register("im215-life-alice"); admin = await h.register("im215-life-admin");
  await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
});
beforeEach(async () => { f.setLifetime(3600); f.patches.clear(); f.replies.clear(); f.modes.clear(); await h.resetLimits(); });
after(async () => { await h?.close(); await f?.close(); });

test("shared expiry merge preserves old providers and rejects unsafe, expired or out-of-range remote epochs", async () => {
  const bundle = await build({ entryPoints: [new URL("../src/mailbox-creation-expiry.ts", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], bundle: true, write: false, format: "esm", platform: "node" });
  const { creationExpiry } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(creationExpiry(null), null); assert.equal(creationExpiry(now + 20, null), now + 20);
  assert.equal(creationExpiry(null, now + 40), now + 40); assert.equal(creationExpiry(now + 20, now + 40), now + 20);
  for (const value of [0, now - 1, now + 0.5, NaN, Infinity, "123", 253402300800, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => creationExpiry(null, value));
});

test("actual upstream expiry, explicit null and shorter platform policy remain consistent across mailbox, guard, API and restart", async () => {
  for (const [lifetime, enabled, days] of [[3600, false, 0], [null, false, 0], [3 * 86400, true, 1], [3600, true, 1], [null, true, 1]]) {
    f.setLifetime(lifetime); await policy({ enabled, mailboxDays: days });
    const result = await allocate(); assert.equal(result.status, 201, result.text); const box = result.body.mailbox;
    const remote = f.accounts.get(box.address).expiresAt, expected = Math.min(enabled ? box.createdAt + days * 86400 : Infinity, remote === null ? Infinity : Math.floor(Date.parse(remote) / 1000));
    assert.equal(box.expiresAt, expected === Infinity ? null : expected);
    const guard = await h.db.prepare("SELECT expires_at FROM mailbox_creations WHERE mailbox_id=?").bind(box.id).first(); assert.equal(guard.expires_at, box.expiresAt);
    await h.restart(); const detail = await h.request(`/api/v1/mailboxes/${box.id}`, { cookie: alice.cookie }); assert.equal(detail.body.mailbox.expiresAt, box.expiresAt);
  }
  await policy({ enabled: false, mailboxDays: 0 });
});

test("invalid creation/profile expiry and identity fail unknown without token fallback, recreation or compensating deletion", async () => {
  const invalid = [undefined, "", "not-a-date", "2099-02-30T01:00:00Z", "2099-01-01T24:00:00Z", "2000-01-01T00:00:00Z", 123];
  const cases = [...invalid.map(expiresAt => ["/accounts", { expiresAt }]), ...invalid.map(expiresAt => ["/accounts/me", { expiresAt }]),
    ["/accounts", { mode: "wildcard" }], ["/accounts", { token: "AC-synthetic-im215-platform-key" }], ["/accounts", { token: "" }],
    ["/accounts/me", { id: "foreign" }], ["/accounts/me", { isActive: false }], ["/accounts/me", { inboxType: "persistent" }]];
  for (const [route, patch] of cases) {
    f.patches.clear(); f.patches.set(route, patch); const key = crypto.randomUUID(), start = f.calls.length;
    const result = await allocate({ headers: { "idempotency-key": key } }); assert.equal(result.status, 202, result.text); assert.equal(result.body.creation.state, "unknown");
    assert.equal(await h.db.prepare("SELECT 1 FROM mailboxes WHERE id=?").bind(result.body.creation.mailboxId).first(), null);
    const end = f.calls.length; assert.equal((await allocate({ headers: { "idempotency-key": key } })).body.creation.state, "unknown"); assert.equal(f.calls.length, end);
    assert.equal(f.calls.slice(start).filter(call => call.route === "/accounts").length, 1);
    assert.ok(f.calls.slice(start).every(call => ["/domains", "/accounts", "/accounts/me"].includes(call.route)));
  }
});

test("creation completion and expiry receipt commit atomically, including a failure updating the guard", async () => {
  await h.db.prepare("CREATE TRIGGER im215_expiry_fail BEFORE UPDATE OF expires_at ON mailbox_creations BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try {
    const result = await allocate(); assert.equal(result.body.creation.state, "unknown"); const id = result.body.creation.mailboxId;
    assert.equal(await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(id).first(), null);
    assert.equal((await h.db.prepare("SELECT state,expires_at FROM mailbox_creations WHERE mailbox_id=?").bind(id).first()).expires_at, null);
  } finally { await h.db.prepare("DROP TRIGGER im215_expiry_fail").run(); }
});

test("domain discovery rejects malformed/duplicate results, excludes non-ready domains and preserves explicit allowlists", async () => {
  const read = () => h.request("/api/v1/providers/im215/domains", { cookie: alice.cookie });
  assert.deepEqual((await read()).body.domains, ["im215.example.test"]);
  const domain = { domain: "im215.example.test", isVerified: true, isMxValid: true };
  for (const values of [[domain, domain], [{ ...domain, domain: "https://invalid.example" }], [{ ...domain, isMxValid: "true" }], {}]) {
    f.replies.set("/domains", { success: true, data: values }); assert.equal((await read()).status, 502);
  }
  f.replies.set("/domains", { success: true, data: [{ ...domain, isMxValid: false }, { ...domain, domain: "other.example.test" }] });
  assert.deepEqual((await read()).body.domains, []);
});

test("the earlier of create and profile deadlines wins and a valid empty inbox completes without a hidden read mutation", async () => {
  f.setLifetime(null); const deadline = new Date(Date.now() + 1800 * 1000).toISOString(); f.patches.set("/accounts/me", { expiresAt: deadline });
  const result = await allocate(); assert.equal(result.status, 201, result.text); assert.equal(result.body.mailbox.expiresAt, Math.floor(Date.parse(deadline) / 1000));
  assert.equal((await sync(result.body.mailbox)).body.sync.complete, true);
  const starts = f.calls.length; f.patches.set("/accounts/me", { expiresAt: "2000-01-01T00:00:00Z" });
  assert.equal((await sync(result.body.mailbox)).status, 502); assert.deepEqual(f.calls.slice(starts).map(call => call.route), ["/accounts/me"]);
});

test("failed cache/cursor writes preserve the previous checkpoint and expired mailboxes perform no upstream HTTP", async () => {
  const box = (await allocate()).body.mailbox, account = f.accounts.get(box.address);
  f.messages.set(box.address, Array.from({ length: 21 }, (_, n) => im215Mail(account, n + 1))); assert.equal((await sync(box)).body.sync.inserted, 10);
  const cursor = () => h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(box.id).first(), before = await cursor();
  for (const [name, trigger] of [["cache", "BEFORE INSERT ON messages"], ["cursor", "BEFORE UPDATE ON provider_sync_cursors"]]) {
    await h.db.prepare(`CREATE TRIGGER im215_${name}_fail ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic'); END`).run();
    try { assert.equal((await sync(box, 2)).body.error.code, "sync_storage_failed"); }
    finally { await h.db.prepare(`DROP TRIGGER im215_${name}_fail`).run(); }
    assert.deepEqual(await cursor(), before); assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=?").bind(box.id).first()).n, 10);
  }
  assert.equal((await sync(box, 2)).body.sync.inserted, 10);
  await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run(); const start = f.calls.length;
  assert.equal((await sync(box)).body.error.code, "mailbox_expired"); assert.equal(f.calls.length, start);
});

test("in-flight lease replacement or expiry cannot install late messages or advance the cursor", async () => {
  for (const change of ["expires_at=unixepoch()-1", "sync_token='successor',sync_lease_until=unixepoch()+60"]) {
    const box = (await allocate()).body.mailbox, account = f.accounts.get(box.address); f.messages.set(box.address, [im215Mail(account)]);
    const gate = f.hold("/messages/mail-00001"), pending = sync(box);
    try { await gate.entered; await h.db.prepare(`UPDATE mailboxes SET ${change} WHERE id=?`).bind(box.id).run(); }
    finally { gate.release(); }
    assert.equal((await pending).body.error.code, "sync_lease_lost"); assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=?").bind(box.id).first()).n, 0);
    assert.equal(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(box.id).first(), null);
  }
});

test("215 requires platform credentials, rejects anonymous config, persists admin configuration and cannot silently downgrade", async () => {
  const save = config => h.request("/api/v1/admin/providers/im215", { method: "PUT", cookie: admin.cookie, body: { expectedRevision: 0, config, secretAction: "keep" } });
  assert.equal((await save({ ...f.config, authentication: "anonymous" })).status, 400); assert.equal((await save(f.config)).status, 200); await h.restart();
  assert.equal((await h.request("/api/v1/admin/providers", { cookie: admin.cookie })).body.items[0].config.type, "im215");
  await h.restart({ PROVIDER_SECRETS: "{}" }); const start = f.calls.length;
  assert.equal((await h.request("/api/v1/providers", { cookie: alice.cookie })).body.items[0].allocation.available, false);
  assert.equal((await allocate()).body.error.code, "provider_secret_unavailable"); assert.equal(f.calls.length, start);
});
