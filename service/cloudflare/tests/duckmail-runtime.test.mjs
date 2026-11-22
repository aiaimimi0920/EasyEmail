import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { duckMail, duckmailFixture } from "./duckmail-fixture.mjs";

let h, f, alice, bob, admin, mailbox;
const allocate = (extra = {}) => h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie,
  headers: { "idempotency-key": crypto.randomUUID() }, body: { providerId: "duckmail", domain: "duckmail.example.test" }, ...extra });
const sync = (extra = {}) => h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: "POST", cookie: alice.cookie, body: {}, ...extra });
const list = () => h.request(`/api/v1/mailboxes/${mailbox.id}/messages?limit=100`, { cookie: alice.cookie });
before(async () => {
  f = await duckmailFixture(); h = await createHarness(f.bindings);
  alice = await h.register("duckmail-alice"); bob = await h.register("duckmail-bob"); admin = await h.register("duckmail-admin");
  await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
});
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); f.replies.clear(); });
after(async () => { await h?.close(); await f?.close(); });

test("DuckMail catalog, complete verified domain pagination and honest unsupported credential probe", async () => {
  const catalog = await h.request("/api/v1/providers", { cookie: alice.cookie }); assert.equal(catalog.status, 200, catalog.text);
  assert.equal(catalog.body.items[0].capabilities.allocation, "remote-create");
  for (const name of ["send", "attachmentDownload", "restoreByAddress", "customPrefix", "conditionalRemoteMailboxDelete"]) assert.equal(catalog.body.items[0].capabilities[name], false);
  const domains = await h.request("/api/v1/providers/duckmail/domains", { cookie: alice.cookie }); assert.deepEqual(domains.body.domains, f.domains);
  const count = f.calls.length, probe = await h.request("/api/v1/admin/providers/duckmail/probe", { method: "POST", cookie: admin.cookie, body: {} });
  assert.equal(probe.body.error.code, "provider_probe_unavailable"); assert.equal(f.calls.length, count);
  assert.equal(await h.db.prepare("SELECT * FROM provider_health WHERE provider_id='duckmail'").first(), null);
});

test("scoped allocation uses one exact create, separate password login and verified mailbox identity without credential crossover", async () => {
  const key = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:read"] });
  const input = { token: key.token, cookie: undefined, origin: null, headers: { "idempotency-key": crypto.randomUUID() } };
  const start = f.calls.length, result = await allocate(input); assert.equal(result.status, 201, result.text); mailbox = result.body.mailbox;
  const account = f.accounts.get(mailbox.address), calls = f.calls.slice(start);
  assert.equal(mailbox.expiresAt - mailbox.createdAt, 86400);
  assert.equal(calls.filter(call => call.path === "/accounts").length, 1); assert.equal(calls.filter(call => call.path === "/token").length, 1);
  assert.equal(calls.at(-1).path, "/me"); assert.equal(calls.find(call => call.path === "/token").headers.authorization, undefined);
  const count = f.calls.length; assert.equal((await allocate(input)).body.mailbox.id, mailbox.id); assert.equal(f.calls.length, count);
  const row = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(mailbox.id).first(); assert.equal(row.remote_id, account.id); assert.ok(row.credential_cipher);
  for (const secret of [account.token, account.password, "dk_synthetic_platform_key"]) assert.equal((JSON.stringify(row) + result.text).includes(secret), false);
});

test("31 messages survive numeric paging and restart; metadata stays viewable but unverified attachment URLs are never followed", async () => {
  f.messages.set(mailbox.address, Array.from({ length: 31 }, (_, n) => duckMail(f.accounts.get(mailbox.address), n + 1)));
  const first = await sync(); assert.equal(first.status, 200, first.text); assert.equal(first.body.sync.inserted, 30); assert.equal(first.body.sync.nextPage, 2);
  await h.restart(); const last = await sync({ body: { page: 2 } }); assert.equal(last.body.sync.inserted, 1); assert.equal(last.body.sync.complete, true);
  assert.equal((await list()).body.items.length, 31);
  assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM provider_sync_cursors").first()).n, 0, "DuckMail does not invent upstream cursors");
  const otp = await h.request(`/api/v1/mailboxes/${mailbox.id}/extractions?since=1`, { cookie: alice.cookie }); assert.equal(otp.body.items[0].otp.code, "735296");
  const message = (await list()).body.items[0]; const detail = await h.request(`/api/v1/mailboxes/${mailbox.id}/messages/${message.id}`, { cookie: alice.cookie });
  assert.equal(detail.body.message.attachments[0].filename, "sample.txt"); assert.equal(detail.body.message.attachments[0].downloadAvailable, false);
  assert.equal(detail.text.includes("https://invalid.example"), false); assert.equal((await sync()).body.sync.inserted, 0);
});

test("mailbox identity, list account/recipient and detail identity bind mail reads to the encrypted account", async () => {
  const account = f.accounts.get(mailbox.address), original = duckMail(account, 99), size = (await list()).body.items.length;
  f.messages.set(mailbox.address, [original]); let count = f.calls.length;
  f.replies.set("/me", { id: "different", address: mailbox.address }); assert.equal((await sync()).status, 502);
  assert.equal(f.calls.slice(count).some(call => call.path === "/messages"), false); f.replies.clear();
  for (const patch of [{ accountId: "foreign" }, { to: [{ address: "victim@example.test" }] }, { id: "../accounts" }]) {
    f.replies.set("/messages", f.collection([{ ...original, ...patch }], "/messages", 1)); assert.equal((await sync()).status, 502);
  }
  f.replies.clear();
  for (const patch of [{ id: "different" }, { accountId: "foreign" }, { to: [{ address: "victim@example.test" }] }, { html: [1] }]) {
    f.replies.set(`/messages/${original.id}`, { ...original, ...patch }); assert.equal((await sync()).status, 502);
  }
  assert.equal((await list()).body.items.length, size);
});

test("Hydra counts and page pointers are validated, never followed as arbitrary URLs or silently truncated", async () => {
  const original = duckMail(f.accounts.get(mailbox.address), 99), data = f.collection([original], "/messages", 1);
  for (const patch of [{ "hydra:totalItems": 31 }, { "hydra:member": [original, original], "hydra:totalItems": 2 },
    { "hydra:view": { ...data["hydra:view"], "hydra:last": "https://invalid.example/messages?page=1" } },
    { "hydra:view": { ...data["hydra:view"], "hydra:last": "/accounts?page=1" } },
    { "hydra:view": { ...data["hydra:view"], "hydra:next": "/messages?page=1" } }]) {
    f.replies.set("/messages", { ...data, ...patch }); assert.equal((await sync()).status, 502);
  }
  f.replies.clear(); f.replies.set("/domains", { "hydra:member": [], "hydra:totalItems": 1001, "hydra:view": {} });
  assert.equal((await h.request("/api/v1/providers/duckmail/domains", { cookie: alice.cookie })).status, 502);
  assert.equal(f.calls.some(call => call.path === "/exfiltrate"), false);
});

test("HTTP failures, missing details and failed D1 batches remain bounded and cannot replace confirmed cache", async () => {
  const original = duckMail(f.accounts.get(mailbox.address), 88), size = (await list()).body.items.length; f.messages.set(mailbox.address, [original]);
  for (const mode of [401, 429, 500, "redirect", "invalid", "html", "oversized"]) {
    f.modes.set("/messages", mode); const result = await sync(); assert.equal(result.status, 502); assert.equal(result.text.includes("synthetic-private-error"), false);
    assert.equal((await list()).body.items.length, size);
  }
  f.modes.clear(); f.modes.set(`/messages/${original.id}`, 404);
  const missing = await sync(); assert.equal(missing.body.sync.missing, 1); assert.equal(missing.body.sync.complete, false); f.modes.clear();
  await h.db.prepare("CREATE TRIGGER duck_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { assert.equal((await sync()).body.error.code, "sync_storage_failed"); }
  finally { await h.db.prepare("DROP TRIGGER duck_fail").run(); }
  assert.equal((await list()).body.items.length, size);
});

test("lost create/login ACK, inconsistent token identity and local storage failure never recreate or destructively compensate", async () => {
  for (const mode of ["create", "token", "identity", "storage"]) {
    await h.resetLimits(); await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='duckmail'").run();
    if (mode === "storage") await h.db.prepare("CREATE TRIGGER duck_create_fail BEFORE INSERT ON mailboxes BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
    else if (mode === "identity") f.replies.set("/token", { id: "foreign", token: "synthetic-foreign-token" });
    else f.modes.set(mode === "create" ? "/accounts" : "/token", "lost-ack");
    const headers = { "idempotency-key": crypto.randomUUID() }, start = f.calls.length;
    try {
      const result = await allocate({ headers }); assert.equal(result.status, 202, result.text); assert.equal(result.body.creation.state, "unknown");
      assert.equal(result.body.creation.retrySafe, false); const count = f.calls.length;
      assert.equal((await allocate({ headers })).body.creation.mailboxId, result.body.creation.mailboxId); assert.equal(f.calls.length, count);
      assert.equal(f.calls.slice(start).filter(call => call.path === "/accounts").length, 1); assert.equal(f.calls.slice(start).some(call => call.method === "DELETE"), false);
    } finally { if (mode === "storage") await h.db.prepare("DROP TRIGGER duck_create_fail").run(); f.modes.clear(); f.replies.clear(); }
  }
});

test("cross-user calls and copied mailbox ciphertext fail before provider I/O; late lease holders cannot install messages", async () => {
  let count = f.calls.length; assert.equal((await sync({ cookie: bob.cookie })).status, 404); assert.equal(f.calls.length, count);
  await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='duckmail'").run();
  const other = (await allocate({ cookie: bob.cookie })).body.mailbox, row = await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  await h.db.prepare("UPDATE mailboxes SET credential_cipher=? WHERE id=?").bind(row.credential_cipher, other.id).run(); count = f.calls.length;
  const result = await h.request(`/api/v1/mailboxes/${other.id}/sync`, { method: "POST", cookie: bob.cookie, body: {} });
  assert.equal(result.body.error.code, "mailbox_credential_unavailable"); assert.equal(f.calls.length, count);
  const size = (await list()).body.items.length, gate = f.hold("/messages"), pending = sync();
  try { await gate.entered; await h.db.prepare("UPDATE mailboxes SET sync_token='successor',sync_lease_until=unixepoch()+60 WHERE id=?").bind(mailbox.id).run(); }
  finally { gate.release(); }
  assert.equal((await pending).body.error.code, "sync_lease_lost"); assert.equal((await list()).body.items.length, size);
  await h.db.prepare("UPDATE mailboxes SET sync_token=NULL,sync_lease_until=NULL WHERE id=?").bind(mailbox.id).run();
});

test("admin allowlists and encrypted rotation retain immutable endpoint identity and automatic selection after restart", async () => {
  const body = { expectedRevision: 0, config: { ...f.config, domains: ["duckmail.example.test"] }, secretAction: "replace", secret: { apiKey: "dk_synthetic_platform_key" } };
  const save = value => h.request("/api/v1/admin/providers/duckmail", { method: "PUT", cookie: admin.cookie, body: value });
  assert.equal((await save({ ...body, config: { ...body.config, sendTransport: "binding", sendRecipients: ["*"] } })).status, 400);
  assert.equal((await save(body)).status, 200); assert.equal((await save(body)).status, 409);
  await h.restart(); const result = await allocate({ body: { selection: "automatic" } }); assert.equal(result.status, 201, result.text);
  assert.equal(result.body.mailbox.providerId, "duckmail");
  const stored = await h.db.prepare("SELECT * FROM provider_overrides WHERE id='duckmail'").first();
  assert.equal(stored.secret_source, "stored"); assert.equal(stored.secret_cipher.includes("dk_synthetic_platform_key"), false);
});
