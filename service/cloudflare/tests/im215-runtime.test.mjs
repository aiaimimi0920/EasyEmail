import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { im215Fixture, im215Mail } from "./im215-fixture.mjs";

let h, f, alice, bob, admin, mailbox;
const allocate = (extra = {}) => h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie,
  headers: { "idempotency-key": crypto.randomUUID() }, body: { providerId: "im215", domain: "im215.example.test" }, ...extra });
const sync = (extra = {}) => h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: "POST", cookie: alice.cookie, body: {}, ...extra });
const list = () => h.request(`/api/v1/mailboxes/${mailbox.id}/messages?limit=100`, { cookie: alice.cookie });
before(async () => {
  f = await im215Fixture(); h = await createHarness(f.bindings);
  alice = await h.register("im215-alice"); bob = await h.register("im215-bob"); admin = await h.register("im215-admin");
  await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
});
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); f.patches.clear(); f.replies.clear(); });
after(async () => { await h?.close(); await f?.close(); });

test("215 public domains cannot prove API Key validity; capability and probe paths never create inboxes", async () => {
  const catalog = await h.request("/api/v1/providers", { cookie: alice.cookie }); assert.equal(catalog.status, 200, catalog.text);
  assert.equal(catalog.body.items[0].allocation.available, true);
  for (const name of ["send", "attachmentDownload", "restoreByAddress", "customPrefix", "conditionalRemoteMailboxDelete"]) assert.equal(catalog.body.items[0].capabilities[name], false);
  assert.deepEqual((await h.request("/api/v1/providers/im215/domains", { cookie: alice.cookie })).body.domains, ["im215.example.test"]);
  const count = f.calls.length, probe = await h.request("/api/v1/admin/providers/im215/probe", { method: "POST", cookie: admin.cookie, body: {} });
  assert.equal(probe.body.error.code, "provider_probe_unavailable"); assert.equal(f.calls.length, count);
  assert.equal(await h.db.prepare("SELECT * FROM provider_health WHERE provider_id='im215'").first(), null);
  assert.equal(f.calls.some(call => call.method !== "GET"), false);
});

test("creation uses one exact fixed-domain POST with a stable upstream key, verifies the temp token, persists actual expiry and replays locally", async () => {
  const key = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:read"] });
  const extra = { cookie: undefined, token: key.token, origin: null, headers: { "idempotency-key": crypto.randomUUID() } };
  const result = await allocate(extra); assert.equal(result.status, 201, result.text); mailbox = result.body.mailbox;
  const account = f.accounts.get(mailbox.address), row = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  assert.equal(row.remote_id, account.id); assert.equal(mailbox.expiresAt, Math.floor(Date.parse(account.expiresAt) / 1000));
  assert.equal(JSON.stringify(row).includes(account.token), false); assert.equal(JSON.stringify(result.body).includes(account.token), false);
  assert.equal((await h.db.prepare("SELECT expires_at FROM mailbox_creations WHERE mailbox_id=?").bind(mailbox.id).first()).expires_at, mailbox.expiresAt);
  const count = f.calls.length; assert.equal((await allocate(extra)).body.mailbox.id, mailbox.id); assert.equal(f.calls.length, count);
  assert.equal(f.calls.filter(call => call.route === "/accounts").length, 1); assert.equal(f.calls.some(call => call.route === "/token"), false);
});

test("canonical inbox cursor paging survives restart and new arrivals without offset shifts, then supports safe detail and local extraction", async () => {
  const account = f.accounts.get(mailbox.address); f.messages.set(mailbox.address, Array.from({ length: 21 }, (_, n) => im215Mail(account, n + 1)));
  const first = await sync(); assert.equal(first.status, 200, first.text); assert.equal(first.body.sync.inserted, 10); assert.equal(first.body.sync.nextPage, 2);
  f.messages.get(mailbox.address).push(im215Mail(account, 99)); await h.restart();
  const second = await sync({ body: { page: 2 } }); assert.equal(second.body.sync.inserted, 10); assert.equal(second.body.sync.nextPage, 3);
  const last = await sync({ body: { page: 3 } }); assert.equal(last.body.sync.inserted, 1); assert.equal(last.body.sync.complete, true);
  assert.equal((await list()).body.items.length, 21); assert.equal((await sync()).body.sync.inserted, 1);
  const extraction = await h.request(`/api/v1/mailboxes/${mailbox.id}/extractions?since=1`, { cookie: alice.cookie }); assert.equal(extraction.body.items[0].otp.code, "852471");
  const detail = await h.request(`/api/v1/mailboxes/${mailbox.id}/messages/${(await list()).body.items[0].id}`, { cookie: alice.cookie });
  assert.equal(detail.body.message.attachments[0].filename, "sample.txt"); assert.equal(JSON.stringify(detail.body).includes("synthetic-private-url"), false);
  assert.equal(f.calls.some(call => call.route.includes("next") || call.route.includes("mark-read") || call.route.startsWith("/serve")), false);
});

test("profile and message inbox identity reject foreign mail, but BCC/header recipients need not repeat the authorized delivery inbox", async () => {
  const size = (await list()).body.items.length;
  f.patches.set("/accounts/me", { address: "foreign@im215.example.test" }); assert.equal((await sync()).status, 502); f.patches.clear();
  const account = f.accounts.get(mailbox.address), mail = im215Mail(account, 99);
  f.replies.set(`/inboxes/${account.id}/messages`, { success: true, data: { messages: [{ ...mail, inboxId: "foreign" }], total: 1, unreadCount: 1, nextCursor: "" } });
  assert.equal((await sync()).status, 502); f.replies.clear();
  f.patches.set("/messages/mail-00099", { inboxId: "foreign" }); assert.equal((await sync()).status, 502); assert.equal((await list()).body.items.length, size);
  f.patches.set("/messages/mail-00099", { to: [{ address: "visible-to@example.test" }] }); assert.equal((await sync()).status, 200);
});

test("invalid envelopes/cursors, duplicate IDs and incomplete pages fail rather than pretending a complete inbox", async () => {
  const account = f.accounts.get(mailbox.address), mail = im215Mail(account, 99), route = `/inboxes/${account.id}/messages`;
  for (const patch of [{ nextCursor: undefined }, { nextCursor: "https://invalid.example" }, { messages: [], total: 21 },
    { messages: [mail, mail] }, { messages: [mail], nextCursor: "different-id" }, { total: -1 }, { unreadCount: "1" }]) {
    f.replies.set(route, { success: true, data: { messages: [mail], total: 21, unreadCount: 21, nextCursor: "", ...patch } }); assert.equal((await sync()).status, 502);
  }
  for (const reply of [{ success: false, error: "synthetic-private-error" }, { data: {} }, { success: true, data: [] }]) {
    f.replies.set(route, reply); assert.equal((await sync()).status, 502);
  }
});

test("upstream errors and absent details preserve cache, and expired tokens never fall back to platform Key or recreate an address", async () => {
  const account = f.accounts.get(mailbox.address), route = `/inboxes/${account.id}/messages`, size = (await list()).body.items.length;
  for (const mode of [401, 403, 429, 500, "redirect", "invalid", "html", "oversized"]) {
    f.modes.set(route, mode); const result = await sync(); assert.equal(result.status, 502); assert.equal(result.text.includes("synthetic-private-error"), false);
  }
  f.modes.clear(); f.modes.set("/messages/mail-00099", 404); const result = await sync();
  assert.equal(result.body.sync.missing, 1); assert.equal(result.body.sync.complete, false); assert.equal((await list()).body.items.length, size);
  f.modes.clear(); f.modes.set("/accounts/me", 401); const count = f.calls.length; assert.equal((await sync()).status, 502);
  assert.deepEqual(f.calls.slice(count).map(call => call.route), ["/accounts/me"]);
});

test("lost creation ACK, mismatched identity and local storage failure keep unknown original keys without remote retry or compensation", async () => {
  for (const mode of ["lost-ack", "foreign", "storage"]) {
    await h.resetLimits(); await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='im215'").run();
    if (mode === "lost-ack") f.modes.set("/accounts", "lost-ack");
    if (mode === "foreign") f.patches.set("/accounts", { address: "foreign@im215.example.test" });
    if (mode === "storage") await h.db.prepare("CREATE TRIGGER im215_fail BEFORE INSERT ON mailboxes BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
    const extra = { headers: { "idempotency-key": crypto.randomUUID() } }, count = f.calls.length;
    try {
      const result = await allocate(extra); assert.equal(result.status, 202, result.text); assert.equal(result.body.creation.state, "unknown"); assert.equal(result.body.creation.retrySafe, false);
      const end = f.calls.length; assert.equal((await allocate(extra)).body.creation.mailboxId, result.body.creation.mailboxId); assert.equal(f.calls.length, end);
      assert.equal(f.calls.slice(count).filter(call => call.route === "/accounts").length, 1); assert.equal(f.calls.slice(count).some(call => call.method === "DELETE"), false);
    } finally { f.modes.clear(); f.patches.clear(); if (mode === "storage") await h.db.prepare("DROP TRIGGER im215_fail").run(); }
  }
});

test("other users and copied ciphertext are rejected before upstream I/O", async () => {
  let count = f.calls.length; assert.equal((await sync({ cookie: bob.cookie })).status, 404); assert.equal(f.calls.length, count);
  await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='im215'").run();
  const other = (await allocate({ cookie: bob.cookie })).body.mailbox, row = await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  await h.db.prepare("UPDATE mailboxes SET credential_cipher=? WHERE id=?").bind(row.credential_cipher, other.id).run(); count = f.calls.length;
  const result = await h.request(`/api/v1/mailboxes/${other.id}/sync`, { method: "POST", cookie: bob.cookie, body: {} });
  assert.equal(result.body.error.code, "mailbox_credential_unavailable"); assert.equal(f.calls.length, count);
});
