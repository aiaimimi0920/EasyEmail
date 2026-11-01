import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { moeMail, moemailFixture } from "./moemail-fixture.mjs";

let h, f, alice, bob, admin, mailbox;
const allocate = (extra = {}) => h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie,
  headers: { "idempotency-key": crypto.randomUUID() }, body: { providerId: "moemail", domain: "moemail.example.test" }, ...extra });
const sync = (extra = {}) => h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: "POST", cookie: alice.cookie, body: {}, ...extra });
const list = () => h.request(`/api/v1/mailboxes/${mailbox.id}/messages?limit=100`, { cookie: alice.cookie });
before(async () => {
  f = await moemailFixture(); h = await createHarness(f.bindings);
  alice = await h.register("moemail-alice"); bob = await h.register("moemail-bob"); admin = await h.register("moemail-admin");
  await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
});
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); f.replies.clear(); });
after(async () => { await h?.close(); await f?.close(); });

test("MoEmail domains, authenticated probe and capability catalog use the configured instance without inventing unsupported operations", async () => {
  const catalog = await h.request("/api/v1/providers", { cookie: alice.cookie });
  assert.equal(catalog.status, 200, catalog.text); assert.equal(catalog.body.items[0].allocation.available, true);
  for (const field of ["send", "attachmentDownload", "restoreByAddress", "customPrefix", "conditionalRemoteMailboxDelete"]) assert.equal(catalog.body.items[0].capabilities[field], false);
  const domains = await h.request("/api/v1/providers/moemail/domains", { cookie: alice.cookie });
  assert.deepEqual(domains.body.domains, ["moemail.example.test", "other.example.test"]);
  const probe = await h.request("/api/v1/admin/providers/moemail/probe", { method: "POST", cookie: admin.cookie, body: {} });
  assert.equal(probe.body.health.state, "ok", probe.text); assert.equal(probe.text.includes("synthetic-moemail-key"), false);
});

test("scoped API allocation binds exact address/id and idempotent replays never repeat the upstream POST", async () => {
  const key = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:read"] });
  const input = { token: key.token, cookie: undefined, origin: null, headers: { "idempotency-key": crypto.randomUUID() } };
  const result = await allocate(input); assert.equal(result.status, 201, result.text); mailbox = result.body.mailbox;
  assert.equal(mailbox.expiresAt - mailbox.createdAt, 3600, "Upstream one-hour lifetime is not presented as permanent");
  const count = f.calls.length; assert.equal((await allocate(input)).body.mailbox.id, mailbox.id); assert.equal(f.calls.length, count);
  const row = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  assert.equal(row.remote_id, f.mailboxes.get(mailbox.address).id); assert.ok(row.credential_cipher);
  assert.equal((JSON.stringify(row) + result.text).includes("synthetic-moemail-key"), false);
});

test("cursor continuation survives restart; all 21 messages and fresh OTP are available through cached Web/API contracts", async () => {
  f.messages.set(mailbox.address, Array.from({ length: 21 }, (_, n) => moeMail(mailbox.address, n + 1)));
  const count = f.calls.length; assert.deepEqual((await list()).body.items, []); assert.equal(f.calls.length, count);
  const first = await sync(); assert.equal(first.status, 200, first.text); assert.equal(first.body.sync.inserted, 20); assert.equal(first.body.sync.nextPage, 2);
  const continuation = await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first();
  assert.equal(continuation.cursor, "cursor+/20"); assert.equal(continuation.next_page, 2);
  await h.restart();
  const second = await sync({ body: { page: 2 } }); assert.equal(second.body.sync.inserted, 1); assert.equal(second.body.sync.complete, true);
  assert.equal(f.calls.filter(call => call.path === `/api/emails/${rowId()}`).at(-1).query.get("cursor"), "cursor+/20");
  assert.equal((await list()).body.items.length, 21);
  const otp = await h.request(`/api/v1/mailboxes/${mailbox.id}/extractions?since=1`, { cookie: alice.cookie });
  assert.equal(otp.body.items[0].otp.code, "735296");
  assert.equal((await sync()).body.sync.inserted, 0);
});
const rowId = () => f.mailboxes.get(mailbox.address).id;

test("cross-user access and copied encrypted mailbox references are rejected before external I/O", async () => {
  let count = f.calls.length;
  assert.equal((await sync({ cookie: bob.cookie })).status, 404); assert.equal(f.calls.length, count);
  const other = (await allocate({ cookie: bob.cookie })).body.mailbox;
  const row = await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  await h.db.prepare("UPDATE mailboxes SET credential_cipher=? WHERE id=?").bind(row.credential_cipher, other.id).run();
  count = f.calls.length;
  const result = await h.request(`/api/v1/mailboxes/${other.id}/sync`, { method: "POST", cookie: bob.cookie, body: {} });
  assert.equal(result.body.error.code, "mailbox_credential_unavailable"); assert.equal(f.calls.length, count);
});

test("malformed cursors, list/detail identity and recipient mismatches never change confirmed cache or follow external URLs", async () => {
  const path = `/api/emails/${rowId()}`, original = moeMail(mailbox.address, 99), size = (await list()).body.items.length;
  const invalid = [
    { messages: [original], nextCursor: 1 }, { messages: [], nextCursor: "nonempty-without-messages" },
    { messages: [{ ...original, id: "../config" }], nextCursor: null },
    { messages: [{ ...original, to_address: "victim@example.test" }], nextCursor: null },
    { messages: Array.from({ length: 21 }, () => original), nextCursor: null },
  ];
  for (const value of invalid) {
    f.replies.set(path, value); assert.equal((await sync()).status, 502); assert.equal((await list()).body.items.length, size);
  }
  f.replies.set(path, { messages: [original], nextCursor: null });
  for (const message of [{ ...original, id: "different" }, { ...original, to_address: "victim@example.test" }, { ...original, type: "sent" }]) {
    f.replies.set(`${path}/${original.id}`, { message }); assert.equal((await sync()).status, 502);
    assert.equal((await list()).body.items.length, size);
  }
});

test("HTTP auth/rate, malformed, oversized and redirects remain bounded and preserve cache without leaking provider response bodies", async () => {
  const size = (await list()).body.items.length;
  for (const mode of [401, 429, 500, "redirect", "invalid", "oversized"]) {
    f.modes.set(`/api/emails/${rowId()}`, mode); const result = await sync();
    assert.equal(result.status, 502, result.text); assert.equal(result.text.includes("synthetic-private-error"), false);
    assert.equal((await list()).body.items.length, size);
  }
  assert.equal(f.calls.some(call => call.path === "/exfiltrate"), false);
});

test("missing details are visible and an atomic D1 failure cannot advance the cursor past uncommitted messages", async () => {
  const path = `/api/emails/${rowId()}`, original = moeMail(mailbox.address, 88);
  f.replies.set(path, { messages: [original], nextCursor: "next+/page" }); f.modes.set(`${path}/${original.id}`, 404);
  const missing = await sync(); assert.equal(missing.body.sync.missing, 1); assert.equal(missing.body.sync.complete, false);
  const before = await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first();
  f.messages.set(mailbox.address, [original]); f.modes.clear();
  await h.db.prepare("CREATE TRIGGER moe_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { assert.equal((await sync()).body.error.code, "sync_storage_failed"); }
  finally { await h.db.prepare("DROP TRIGGER moe_fail").run(); }
  assert.deepEqual(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first(), before);
});

test("lost upstream creation ACK and local write failure remain unknown, never retried or compensated by destructive delete", async () => {
  for (const storageFailure of [false, true]) {
    await h.resetLimits(); await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='moemail'").run();
    if (storageFailure) await h.db.prepare("CREATE TRIGGER moe_create_fail BEFORE INSERT ON mailboxes BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
    else f.modes.set("/api/emails/generate", "lost-ack");
    const headers = { "idempotency-key": crypto.randomUUID() }, start = f.calls.length;
    try {
      const result = await allocate({ headers }); assert.equal(result.status, 202, result.text);
      assert.equal(result.body.creation.state, "unknown"); assert.equal(result.body.creation.retrySafe, false);
      const count = f.calls.length; assert.equal((await allocate({ headers })).body.creation.mailboxId, result.body.creation.mailboxId);
      assert.equal(f.calls.length, count); assert.equal(f.calls.slice(start).filter(call => call.path === "/api/emails/generate").length, 1);
      assert.equal(f.calls.slice(start).some(call => call.method === "DELETE"), false);
    } finally { if (storageFailure) await h.db.prepare("DROP TRIGGER moe_create_fail").run(); f.modes.clear(); }
  }
});

test("admin secret rotation, domain allowlist and automatic selection persist with immutable provider identity", async () => {
  const body = { expectedRevision: 0, config: { ...f.config, domains: ["moemail.example.test"] }, secretAction: "replace", secret: { apiKey: "synthetic-moemail-key" } };
  const save = value => h.request("/api/v1/admin/providers/moemail", { method: "PUT", cookie: admin.cookie, body: value });
  assert.equal((await save({ ...body, config: { ...body.config, sendTransport: "binding", sendRecipients: ["*"] } })).status, 400);
  assert.equal((await save(body)).status, 200); assert.equal((await save(body)).status, 409);
  await h.restart(); const result = await allocate({ body: { selection: "automatic" } }); assert.equal(result.status, 201, result.text);
  assert.equal(result.body.mailbox.providerId, "moemail");
  const stored = await h.db.prepare("SELECT * FROM provider_overrides WHERE id='moemail'").first();
  assert.equal(stored.secret_source, "stored"); assert.equal(stored.secret_cipher.includes("synthetic-moemail-key"), false);
});

test("lost leases cannot replace continuation state; missing or foreign cursor ownership fails before provider I/O", async () => {
  f.messages.set(mailbox.address, Array.from({ length: 21 }, (_, n) => moeMail(mailbox.address, n + 1)));
  assert.equal((await sync()).status, 200);
  const before = await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first();
  const gate = f.hold(`/api/emails/${rowId()}`), pending = sync();
  try {
    await gate.entered;
    assert.equal((await sync()).body.error.code, "sync_in_progress");
    await h.db.prepare("UPDATE mailboxes SET sync_token='successor',sync_lease_until=unixepoch()+60 WHERE id=?").bind(mailbox.id).run();
  } finally { gate.release(); }
  assert.equal((await pending).body.error.code, "sync_lease_lost");
  assert.deepEqual(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first(), before);
  await h.db.prepare("UPDATE mailboxes SET sync_token=NULL,sync_lease_until=NULL WHERE id=?").bind(mailbox.id).run();
  await h.db.prepare("UPDATE provider_sync_cursors SET user_id=? WHERE mailbox_id=?").bind(bob.id, mailbox.id).run();
  const count = f.calls.length;
  assert.equal((await sync({ body: { page: 2 } })).body.error.code, "provider_cursor_unavailable"); assert.equal(f.calls.length, count);
  await h.db.prepare("UPDATE provider_sync_cursors SET user_id=? WHERE mailbox_id=?").bind(alice.id, mailbox.id).run();
  f.replies.set(`/api/emails/${rowId()}`, { messages: [moeMail(mailbox.address, 1)], nextCursor: before.cursor });
  assert.equal((await sync({ body: { page: 2 } })).status, 502, "Repeated upstream cursor is not committed");
  for (const [page, cursor] of [[null, "not-null"], [1, "x"], [2, null], [2, ""], [1001, "x"]]) {
    await assert.rejects(h.db.prepare("UPDATE provider_sync_cursors SET next_page=?,cursor=? WHERE mailbox_id=?").bind(page, cursor, mailbox.id).run());
  }
});
