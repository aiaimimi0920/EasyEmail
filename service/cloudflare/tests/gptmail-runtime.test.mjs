import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { gptMail, gptmailFixture } from "./gptmail-fixture.mjs";

let h, f, alice, bob, admin, mailbox;
const allocate = (extra = {}) => h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie,
  headers: { "idempotency-key": crypto.randomUUID() }, body: { providerId: "gptmail", domain: "gptmail.example.test" }, ...extra });
const sync = (extra = {}) => h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: "POST", cookie: alice.cookie, body: {}, ...extra });
const list = () => h.request(`/api/v1/mailboxes/${mailbox.id}/messages?limit=100`, { cookie: alice.cookie });
before(async () => {
  f = await gptmailFixture(); h = await createHarness(f.bindings);
  alice = await h.register("gptmail-alice"); bob = await h.register("gptmail-bob"); admin = await h.register("gptmail-admin");
  await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
});
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); f.replies.clear(); });
after(async () => { await h?.close(); await f?.close(); });

test("GPTMail catalog and configured domains expose local allocation, not a remote lease or invented authenticated probe", async () => {
  const catalog = await h.request("/api/v1/providers", { cookie: alice.cookie });
  assert.equal(catalog.status, 200, catalog.text); assert.equal(catalog.body.items[0].capabilities.allocation, "random-address");
  for (const field of ["send", "attachmentDownload", "restoreByAddress", "customPrefix", "conditionalRemoteMailboxDelete"]) assert.equal(catalog.body.items[0].capabilities[field], false);
  const domains = await h.request("/api/v1/providers/gptmail/domains", { cookie: alice.cookie });
  assert.deepEqual(domains.body.domains, ["gptmail.example.test"]);
  const probe = await h.request("/api/v1/admin/providers/gptmail/probe", { method: "POST", cookie: admin.cookie, body: {} });
  assert.equal(probe.status, 409, probe.text); assert.equal(probe.body.error.code, "provider_probe_unavailable");
  assert.equal(await h.db.prepare("SELECT * FROM provider_health WHERE provider_id='gptmail'").first(), null);
  assert.equal(f.calls.length, 0);
});

test("scoped API allocation is idempotent, encrypted and does not generate an upstream inbox or invent a 24-hour address expiry", async () => {
  const key = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:read"] });
  const input = { token: key.token, cookie: undefined, origin: null, headers: { "idempotency-key": crypto.randomUUID() } };
  const result = await allocate(input); assert.equal(result.status, 201, result.text); mailbox = result.body.mailbox;
  assert.match(mailbox.address, /^ee[a-f0-9]{32}@gptmail\.example\.test$/); assert.equal(mailbox.expiresAt, null);
  assert.equal((await allocate(input)).body.mailbox.id, mailbox.id); assert.equal(f.calls.length, 0);
  const row = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  assert.equal(row.remote_id, mailbox.address); assert.ok(row.credential_cipher);
  assert.equal((JSON.stringify(row) + result.text).includes("synthetic-gptmail-key"), false);
});

test("bounded list snapshots continue after restart with exact email-scoped detail reads, cached aggregate mail and OTP", async () => {
  f.messages.set(mailbox.address, Array.from({ length: 21 }, (_, n) => gptMail(mailbox.address, n + 1)));
  const start = f.calls.length; assert.deepEqual((await list()).body.items, []); assert.equal(f.calls.length, start);
  assert.equal((await sync()).body.sync.inserted, 10);
  const cursor = await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first();
  assert.match(cursor.cursor, /^gpt1:[a-f0-9]{64}:10$/); assert.equal(cursor.next_page, 2);
  f.messages.get(mailbox.address).reverse(); await h.restart();
  assert.equal((await sync({ body: { page: 2 } })).body.sync.inserted, 10);
  const last = await sync({ body: { page: 3 } }); assert.equal(last.body.sync.inserted, 1); assert.equal(last.body.sync.complete, true);
  assert.equal((await list()).body.items.length, 21);
  const aggregate = await h.request("/api/v1/messages?limit=100", { cookie: alice.cookie }); assert.equal(aggregate.body.items.length, 21);
  const otp = await h.request(`/api/v1/mailboxes/${mailbox.id}/extractions?since=1`, { cookie: alice.cookie }); assert.equal(otp.body.items[0].otp.code, "735296");
  for (const call of f.calls.slice(start)) { assert.equal(call.query.get("email"), mailbox.address); assert.equal(call.method, "GET"); }
  assert.equal((await sync()).body.sync.inserted, 0);
});

test("changed snapshots fail closed without advancing continuation and can restart from page one", async () => {
  f.messages.get(mailbox.address).push(gptMail(mailbox.address, 22));
  const before = await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first();
  const result = await sync({ body: { page: 2 } }); assert.equal(result.body.error.code, "provider_snapshot_changed");
  assert.deepEqual(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first(), before);
  assert.equal((await sync()).status, 200); assert.equal((await sync({ body: { page: 2 } })).status, 200);
  assert.equal((await sync({ body: { page: 3 } })).body.sync.complete, true);
});

test("malformed, truncated, over-limit or ambiguous lists never silently report completion or follow arbitrary IDs", async () => {
  const mail = gptMail(mailbox.address, 99), size = (await list()).body.items.length;
  for (const data of [{ emails: [mail], count: 2 }, { emails: [mail], count: 1, has_more: true }, { emails: [mail] },
    { emails: [mail, mail], count: 2 }, { emails: [{ ...mail, id: "../stats" }], count: 1 },
    { emails: [{ ...mail, email_address: "victim@example.test" }], count: 1 },
    { emails: Array.from({ length: 201 }, (_, n) => gptMail(mailbox.address, n)), count: 201 }]) {
    f.replies.set("/api/emails", { success: true, data }); assert.equal((await sync()).status, 502);
    assert.equal((await list()).body.items.length, size);
  }
  f.replies.set("/api/emails", { success: false, data: { emails: [], count: 0 }, error: "synthetic-private-error" });
  const result = await sync(); assert.equal(result.status, 502); assert.equal(result.text.includes("synthetic-private-error"), false);
});

test("detail identity/recipient mismatch and HTTP failures preserve confirmed cache, redirect isolation and response-body limits", async () => {
  const original = gptMail(mailbox.address, 88), path = `/api/email/${original.id}`, size = (await list()).body.items.length;
  f.messages.set(mailbox.address, [original]);
  for (const patch of [{ id: "different" }, { email_address: "victim@example.test" }, { content: 1 }]) {
    f.replies.set(path, { success: true, data: { ...original, ...patch } }); assert.equal((await sync()).status, 502);
    assert.equal((await list()).body.items.length, size);
  }
  f.replies.clear();
  for (const mode of [401, 429, 500, "redirect", "invalid", "html", "oversized", "disconnect"]) {
    f.modes.set("/api/emails", mode); const result = await sync(); assert.equal(result.status, 502, result.text);
    assert.equal(result.text.includes("synthetic-private-error"), false); assert.equal((await list()).body.items.length, size);
  }
  assert.equal(f.calls.some(call => call.path === "/exfiltrate"), false);
});

test("missing details stay observable and D1 rollback cannot advance past uncommitted mail", async () => {
  const original = gptMail(mailbox.address, 88); f.messages.set(mailbox.address, [original]); f.modes.set(`/api/email/${original.id}`, 404);
  const missing = await sync(); assert.equal(missing.body.sync.missing, 1); assert.equal(missing.body.sync.complete, false);
  f.modes.clear(); const before = await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first();
  await h.db.prepare("CREATE TRIGGER gpt_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { assert.equal((await sync()).body.error.code, "sync_storage_failed"); }
  finally { await h.db.prepare("DROP TRIGGER gpt_fail").run(); }
  assert.deepEqual(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first(), before);
});

test("cross-user requests, invalid credentials and lost leases cannot install mail or continuation", async () => {
  let count = f.calls.length; assert.equal((await sync({ cookie: bob.cookie })).status, 404); assert.equal(f.calls.length, count);
  const other = (await allocate({ cookie: bob.cookie })).body.mailbox;
  const row = await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  await h.db.prepare("UPDATE mailboxes SET credential_cipher=? WHERE id=?").bind(row.credential_cipher, other.id).run(); count = f.calls.length;
  const foreign = await h.request(`/api/v1/mailboxes/${other.id}/sync`, { method: "POST", cookie: bob.cookie, body: {} });
  assert.equal(foreign.body.error.code, "mailbox_credential_unavailable"); assert.equal(f.calls.length, count);
  const before = await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first();
  const gate = f.hold("/api/emails"), pending = sync();
  try { await gate.entered; await h.db.prepare("UPDATE mailboxes SET sync_token='successor',sync_lease_until=unixepoch()+60 WHERE id=?").bind(mailbox.id).run(); }
  finally { gate.release(); }
  assert.equal((await pending).body.error.code, "sync_lease_lost");
  assert.deepEqual(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first(), before);
  await h.db.prepare("UPDATE mailboxes SET sync_token=NULL,sync_lease_until=NULL WHERE id=?").bind(mailbox.id).run();
});

test("admin configuration requires explicit domains and encrypted keys, rejects send policy and preserves identity across restart", async () => {
  const body = { expectedRevision: 0, config: f.config, secretAction: "replace", secret: { apiKey: "synthetic-gptmail-key" } };
  const save = value => h.request("/api/v1/admin/providers/gptmail", { method: "PUT", cookie: admin.cookie, body: value });
  assert.equal((await save({ ...body, config: { ...f.config, domains: [] } })).status, 400);
  assert.equal((await save({ ...body, config: { ...f.config, sendTransport: "binding", sendRecipients: ["*"] } })).status, 400);
  assert.equal((await save(body)).status, 200); assert.equal((await save(body)).status, 409);
  await h.restart(); const result = await allocate({ body: { selection: "automatic" } }); assert.equal(result.status, 201, result.text);
  assert.equal(result.body.mailbox.providerId, "gptmail");
  const stored = await h.db.prepare("SELECT * FROM provider_overrides WHERE id='gptmail'").first();
  assert.equal(stored.secret_source, "stored"); assert.equal(stored.secret_cipher.includes("synthetic-gptmail-key"), false);
});

test("empty and 200-message lists stay bounded; unsupported probe does not clear existing cooldown or install a health success", async () => {
  f.messages.set(mailbox.address, []); const start = f.calls.length;
  assert.equal((await sync()).body.sync.complete, true); assert.equal(f.calls.length - start, 1);
  f.messages.set(mailbox.address, Array.from({ length: 200 }, (_, n) => gptMail(mailbox.address, n + 1)));
  const count = f.calls.length, first = await sync(); assert.equal(first.status, 200, first.text);
  assert.equal(first.body.sync.fetched, 10); assert.equal(first.body.sync.nextPage, 2); assert.equal(f.calls.length - count, 11);
  await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=unixepoch()+60,failure_count=3,last_error='provider_rate_limited' WHERE provider_id='gptmail'").run();
  const before = await h.db.prepare("SELECT * FROM provider_allocation_state WHERE provider_id='gptmail'").first();
  assert.equal((await h.request("/api/v1/admin/providers/gptmail/probe", { method: "POST", cookie: admin.cookie, body: {} })).status, 409);
  assert.deepEqual(await h.db.prepare("SELECT * FROM provider_allocation_state WHERE provider_id='gptmail'").first(), before);
  await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='gptmail'").run();
});

test("local allocation storage failure preserves the unknown original request without generator writes, retries or deletes", async () => {
  const headers = { "idempotency-key": crypto.randomUUID() }, count = f.calls.length;
  await h.db.prepare("CREATE TRIGGER gpt_create_fail BEFORE INSERT ON mailboxes BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  let result;
  try { result = await allocate({ headers }); assert.equal(result.status, 202, result.text); }
  finally { await h.db.prepare("DROP TRIGGER gpt_create_fail").run(); }
  assert.equal(result.body.creation.state, "unknown"); assert.equal(result.body.creation.retrySafe, false);
  assert.equal((await allocate({ headers })).body.creation.mailboxId, result.body.creation.mailboxId);
  assert.equal(f.calls.length, count);
});
