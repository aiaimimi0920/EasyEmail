import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { attachmentMail, binaryRequest, downloadPath } from "./attachment-fixture.mjs";
import { sendFixture, sendRequest, sendCalls } from "./send-fixture.mjs";

let h, f, alice, bob, box, message, fixture;
const lifecycle = (action, extra = {}) => h.request(`/api/v1/mailboxes/${box.id}/lifecycle`, {
  method: "POST", cookie: alice.cookie, body: { action, ...(action === "release" ? { confirmAddress: box.address } : {}) }, ...extra });
const sync = () => h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} });
const mailPath = () => `/api/v1/mailboxes/${box.id}/messages/${message.id}`;
const remove = (extra = {}) => h.request(mailPath(), { method: "DELETE", cookie: alice.cookie, ...extra });
before(async () => {
  f = await sendFixture(); h = await createHarness(f.bindings);
  alice = await h.register("lifecycle-alice"); bob = await h.register("lifecycle-bob");
  box = (await allocate(h, alice.cookie)).body.mailbox;
  fixture = attachmentMail(box.address); f.messages.set(box.address, [fixture.parsed]); f.rawMails.set(box.address, [fixture.raw]);
  assert.equal((await sync()).status, 200);
  message = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items[0];
});
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); });
after(async () => { await h?.close(); await f?.close(); });

test("cache trash is owner-scoped, independently authorized and excluded from extraction without deleting upstream", async () => {
  const writer = await newKey(h, alice.cookie, { scopes: ["messages:write"] });
  const cleaner = await newKey(h, alice.cookie, { scopes: ["messages:delete"] });
  const calls = f.calls.length;
  assert.equal((await remove({ cookie: bob.cookie })).status, 404);
  assert.equal((await remove({ token: writer.token })).status, 403);
  assert.equal((await remove({ origin: null })).status, 403);
  assert.equal((await remove({ token: cleaner.token, origin: null })).status, 200);
  const first = await h.db.prepare("SELECT trashed_at FROM messages WHERE id = ?").bind(message.id).first();
  assert.ok(first.trashed_at);
  assert.equal((await remove()).status, 200);
  assert.deepEqual(await h.db.prepare("SELECT trashed_at FROM messages WHERE id = ?").bind(message.id).first(), first);
  assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items.length, 0);
  assert.equal((await h.request("/api/v1/messages?folder=all", { cookie: alice.cookie })).body.items.length, 0);
  assert.equal((await h.request("/api/v1/messages?folder=trash", { cookie: alice.cookie })).body.items[0].id, message.id);
  assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/extractions?since=1`, { cookie: alice.cookie })).body.items.length, 0);
  assert.equal(f.calls.length, calls);
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(),
    { to: "recipient@example.test", subject: "Not a reply source", text: "synthetic", replyToMessageId: message.id })).body.error.code, "invalid_reply_source");
  assert.equal((await h.request(`${mailPath()}/restore`, { method: "POST", cookie: alice.cookie, body: {} })).status, 200);
  assert.equal((await h.request("/api/v1/messages", { cookie: alice.cookie })).body.items.length, 1);
});

test("permanent cache purge retains dedup/FK tombstone and send guards, never resurrects content on sync", async () => {
  const sent = await sendRequest(h, alice.cookie, box, crypto.randomUUID(),
    { to: "recipient@example.test", subject: "Preserve send guard", text: "synthetic", replyToMessageId: message.id });
  assert.equal(sent.status, 201);
  const guard = await h.db.prepare("SELECT * FROM outgoing_messages WHERE id = ?").bind(sent.body.outgoing.id).first();
  assert.equal((await h.request(`${mailPath()}/purge`, { method: "POST", cookie: alice.cookie, body: { confirmMessageId: message.id } })).status, 409);
  await remove();
  assert.equal((await h.request(`${mailPath()}/purge`, { method: "POST", cookie: alice.cookie, body: { confirmMessageId: "wrong" } })).status, 400);
  const calls = f.calls.length;
  assert.equal((await h.request(`${mailPath()}/purge`, { method: "POST", cookie: alice.cookie, body: { confirmMessageId: message.id } })).status, 200);
  assert.equal(f.calls.length, calls);
  for (const suffix of ["", "/attachments/0"]) {
    const response = suffix ? await binaryRequest(h, downloadPath(box, message), alice.cookie) : await h.request(mailPath(), { cookie: alice.cookie });
    assert.equal(response.status, 404);
  }
  const tombstone = await h.db.prepare("SELECT * FROM messages WHERE id = ?").bind(message.id).first();
  assert.ok(tombstone.purged_at);
  for (const column of ["subject", "sender", "recipient", "text_body", "html_body"]) assert.equal(tombstone[column], "");
  assert.equal(tombstone.attachments, "[]"); assert.equal(tombstone.rfc_message_id, null);
  assert.equal((await h.request(`${mailPath()}/restore`, { method: "POST", cookie: alice.cookie, body: {} })).status, 409);
  assert.equal((await sync()).body.sync.inserted, 0);
  assert.deepEqual(await h.db.prepare("SELECT * FROM messages WHERE id = ?").bind(message.id).first(), tombstone);
  assert.deepEqual(await h.db.prepare("SELECT * FROM outgoing_messages WHERE id = ?").bind(guard.id).first(), guard);
  assert.equal((await h.request("/api/v1/messages?folder=trash", { cookie: alice.cookie })).body.items.length, 0);
});

test("mailbox disable cancels stale sync writes and blocks new external actions while preserving cached history", async () => {
  f.messages.set(box.address, [{ ...fixture.parsed, id: 72, subject: "In-flight must not be cached" }]);
  const gate = f.hold("/cf/api/parsed_mails"), pending = sync();
  try { await gate.entered; assert.equal((await lifecycle("disable")).status, 200); }
  finally { gate.release(); }
  assert.equal((await pending).body.error.code, "sync_lease_lost");
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM messages").first()).n, 1);
  const calls = f.calls.length;
  assert.equal((await sync()).body.error.code, "mailbox_disabled");
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID())).body.error.code, "mailbox_disabled");
  assert.equal(f.calls.length, calls);
  assert.equal((await lifecycle("enable")).status, 200);
  assert.equal((await sync()).body.sync.inserted, 1);
});

test("release revokes platform credential, cannot be undone and preserves idempotency/quota guards across restart", async () => {
  const key = crypto.randomUUID(), sent = await sendRequest(h, alice.cookie, box, key);
  const sendCount = sendCalls(f).length;
  const writer = await newKey(h, alice.cookie, { scopes: ["mailboxes:write"] });
  assert.equal((await lifecycle("release", { token: writer.token })).status, 403);
  assert.equal((await lifecycle("release", { body: { action: "release", confirmAddress: "victim@example.test" } })).status, 400);
  assert.equal((await lifecycle("release", { cookie: bob.cookie })).status, 404);
  const released = await lifecycle("release");
  assert.equal(released.status, 200); assert.ok(released.body.mailbox.releasedAt);
  const row = await h.db.prepare("SELECT * FROM mailboxes WHERE id = ?").bind(box.id).first();
  assert.equal(row.credential_cipher, null); assert.equal(row.sync_token, null);
  assert.equal((await lifecycle("release")).body.mailbox.releasedAt, released.body.mailbox.releasedAt);
  await h.restart();
  assert.equal((await lifecycle("enable")).body.error.code, "mailbox_released");
  assert.equal((await sync()).body.error.code, "mailbox_released");
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID())).body.error.code, "mailbox_released");
  const replay = await sendRequest(h, alice.cookie, box, key);
  assert.equal(replay.body.outgoing.id, sent.body.outgoing.id);
  assert.equal(sendCalls(f).length, sendCount);
  assert.equal((await h.request("/api/v1/outgoing", { cookie: alice.cookie })).body.items.length, 2);
});
