import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { guerrillaMail, guerrillamailFixture } from "./guerrillamail-fixture.mjs";

let h, f, alice, bob, admin, mailbox;
const allocate = (extra = {}) => h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie,
  headers: { "idempotency-key": crypto.randomUUID() }, body: { providerId: "guerrillamail", domain: "guerrilla.example.test" }, ...extra });
const sync = (extra = {}) => h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: "POST", cookie: alice.cookie, body: {}, ...extra });
const list = () => h.request(`/api/v1/mailboxes/${mailbox.id}/messages?limit=100`, { cookie: alice.cookie });
before(async () => {
  f = await guerrillamailFixture(); h = await createHarness(f.bindings);
  alice = await h.register("guerrilla-alice"); bob = await h.register("guerrilla-bob"); admin = await h.register("guerrilla-admin");
  await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
});
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); f.replies.clear(); f.rotations.clear(); });
after(async () => { await h?.close(); await f?.close(); });

test("public session access requires explicit configuration; catalog/domains/probe never create a hidden mailbox", async () => {
  const catalog = await h.request("/api/v1/providers", { cookie: alice.cookie }); assert.equal(catalog.status, 200, catalog.text);
  assert.equal(catalog.body.items[0].allocation.available, true); assert.equal(catalog.body.items[0].capabilities.allocation, "session-select");
  for (const name of ["send", "attachmentDownload", "restoreByAddress", "customPrefix", "conditionalRemoteMailboxDelete"]) assert.equal(catalog.body.items[0].capabilities[name], false);
  assert.deepEqual((await h.request("/api/v1/providers/guerrillamail/domains", { cookie: alice.cookie })).body.domains, f.config.domains);
  const probe = await h.request("/api/v1/admin/providers/guerrillamail/probe", { method: "POST", cookie: admin.cookie, body: {} });
  assert.equal(probe.body.error.code, "provider_probe_unavailable"); assert.equal(f.calls.length, 0);
  assert.equal(await h.db.prepare("SELECT * FROM provider_health WHERE provider_id='guerrillamail'").first(), null);
  assert.equal((await h.request("/api/v1/providers")).status, 401);
});

test("allocation binds exactly the reserved random address to a fresh session, encrypts its token and replays without upstream writes", async () => {
  const key = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:read"] });
  const extra = { cookie: undefined, token: key.token, origin: null, headers: { "idempotency-key": crypto.randomUUID() } };
  const result = await allocate(extra); assert.equal(result.status, 201, result.text); mailbox = result.body.mailbox;
  assert.equal(mailbox.expiresAt, null, "The current official contract says addresses do not expire; message retention is not address lifetime");
  assert.deepEqual(f.calls.map(call => call.f), ["get_email_address", "set_email_user"]);
  const row = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  assert.equal(row.remote_id, mailbox.address); assert.ok(row.credential_cipher); assert.equal(JSON.stringify(row).includes("synthetic-guerrilla-"), false);
  const count = f.calls.length; assert.equal((await allocate(extra)).body.mailbox.id, mailbox.id); assert.equal(f.calls.length, count);
});

test("a verified empty initial inbox completes only with zero count and no detail calls", async () => {
  const count = f.calls.length, result = await sync(); assert.equal(result.status, 200, result.text);
  assert.equal(result.body.sync.fetched, 0); assert.equal(result.body.sync.complete, true); assert.equal(result.body.sync.nextPage, null);
  assert.deepEqual(f.calls.slice(count).map(call => call.f), ["check_email"]);
});

test("seq-based older-page cursors persist across restart, ignore unreliable count pagination and finish on a verified empty tail", async () => {
  f.messages.set(mailbox.address, Array.from({ length: 21 }, (_, n) => guerrillaMail(mailbox.address, n + 1)));
  const first = await sync(); assert.equal(first.status, 200, first.text); assert.equal(first.body.sync.inserted, 20); assert.equal(first.body.sync.nextPage, 2);
  await h.restart(); const second = await sync({ body: { page: 2 } }); assert.equal(second.body.sync.inserted, 1); assert.equal(second.body.sync.nextPage, 3);
  const last = await sync({ body: { page: 3 } }); assert.equal(last.body.sync.fetched, 0); assert.equal(last.body.sync.complete, true);
  assert.equal((await list()).body.items.length, 21);
  assert.equal(f.calls.filter(call => call.f === "get_email_list").length, 0, "Do not use initial offset listing for regular polling");
  assert.deepEqual(f.calls.filter(call => call.f === "get_older_list").map(call => call.query.get("seq")), ["2", "1"]);
  const extraction = await h.request(`/api/v1/mailboxes/${mailbox.id}/extractions?since=1`, { cookie: alice.cookie }); assert.equal(extraction.body.items[0].otp.code, "946281");
  const detail = await h.request(`/api/v1/mailboxes/${mailbox.id}/messages/${(await list()).body.items[0].id}`, { cookie: alice.cookie });
  assert.match(detail.body.message.subject, /^Guerrilla & 😀/); assert.equal(detail.body.message.htmlBody.includes("946281"), true);
});

test("session replacement and foreign recipient never replace an assigned address or confirmed cache", async () => {
  const size = (await list()).body.items.length, count = f.calls.length;
  f.replies.set("check_email", { email: "foreign@guerrilla.example.test", list: [], count: "0", sid_token: "synthetic-foreign" });
  assert.equal((await sync()).body.error.code, "provider_session_changed"); assert.equal(f.calls.length, count + 1);
  f.replies.clear(); f.replies.set("fetch_email", { ...guerrillaMail("foreign@guerrilla.example.test", 21), sid_token: "synthetic-foreign" });
  assert.equal((await sync()).status, 502); assert.equal((await list()).body.items.length, size);
  assert.equal(f.calls.slice(count).some(call => ["get_email_address", "set_email_user", "del_email", "forget_me"].includes(call.f)), false);
});

test("invalid counts, duplicate/noncanonical IDs, oversized lists and nonprogressing older pages fail without pretending completion", async () => {
  const token = [...f.sessions.values()].find(row => row.address === mailbox.address).token, mail = guerrillaMail(mailbox.address, 21);
  for (const patch of [{ count: "NaN" }, { list: [], count: "21" }, { list: [mail, mail] }, { list: [{ ...mail, mail_id: "../x" }] },
    { list: Array.from({ length: 21 }, (_, n) => guerrillaMail(mailbox.address, n + 1)) }]) {
    f.replies.set("check_email", { email: mailbox.address, sid_token: token, list: [mail], count: "21", ...patch }); assert.equal((await sync()).status, 502);
  }
  f.replies.clear(); assert.equal((await sync()).status, 200);
  f.replies.set("get_older_list", { email: mailbox.address, sid_token: token, list: [mail], count: "21" });
  assert.equal((await sync({ body: { page: 2 } })).status, 502);
});

test("HTTP/protocol errors and missing details preserve cache; false is missing, not a successful empty body", async () => {
  const size = (await list()).body.items.length;
  for (const mode of [401, 429, 500, "redirect", "invalid", "html", "oversized"]) {
    f.modes.set("check_email", mode); const result = await sync(); assert.equal(result.status, 502); assert.equal(result.text.includes("synthetic-private-error"), false);
  }
  f.modes.clear(); f.replies.set("fetch_email", false); const missing = await sync();
  assert.equal(missing.body.sync.missing, 20); assert.equal(missing.body.sync.complete, false); assert.equal((await list()).body.items.length, size);
});

test("lost initialization/binding ACK and storage failures retain unknown original keys without automatic session recreation", async () => {
  for (const mode of ["get_email_address", "set_email_user", "storage"]) {
    await h.resetLimits(); await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='guerrillamail'").run();
    if (mode === "storage") await h.db.prepare("CREATE TRIGGER guerrilla_fail BEFORE INSERT ON mailboxes BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
    else f.modes.set(mode, "lost-ack");
    const extra = { headers: { "idempotency-key": crypto.randomUUID() } }, count = f.calls.length;
    try {
      const result = await allocate(extra); assert.equal(result.status, 202, result.text); assert.equal(result.body.creation.state, "unknown"); assert.equal(result.body.creation.retrySafe, false);
      const end = f.calls.length; assert.equal((await allocate(extra)).body.creation.mailboxId, result.body.creation.mailboxId); assert.equal(f.calls.length, end);
      assert.equal(f.calls.slice(count).filter(call => call.f === "get_email_address").length, 1);
      assert.equal(f.calls.slice(count).filter(call => call.f === "set_email_user").length, mode === "get_email_address" ? 0 : 1);
    } finally { f.modes.clear(); if (mode === "storage") await h.db.prepare("DROP TRIGGER guerrilla_fail").run(); }
  }
});

test("cross-user and copied ciphertext fail before provider I/O; public mode never consumes unrelated platform credentials", async () => {
  let count = f.calls.length; assert.equal((await sync({ cookie: bob.cookie })).status, 404); assert.equal(f.calls.length, count);
  await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL WHERE provider_id='guerrillamail'").run();
  const other = (await allocate({ cookie: bob.cookie })).body.mailbox, row = await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(mailbox.id).first();
  await h.db.prepare("UPDATE mailboxes SET credential_cipher=? WHERE id=?").bind(row.credential_cipher, other.id).run(); count = f.calls.length;
  const result = await h.request(`/api/v1/mailboxes/${other.id}/sync`, { method: "POST", cookie: bob.cookie, body: {} });
  assert.equal(result.body.error.code, "mailbox_credential_unavailable"); assert.equal(f.calls.length, count);
});
