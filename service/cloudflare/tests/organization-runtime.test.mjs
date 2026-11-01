import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate, cfMail, providerFixture } from "./provider-fixture.mjs";

let h, f, alice, bob, box, other, message;
const patchBox = (body, extra = {}) => h.request(`/api/v1/mailboxes/${box.id}`, { method: "PATCH", cookie: alice.cookie, body, ...extra });
const patchMessage = (body, extra = {}) => h.request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`,
  { method: "PATCH", cookie: alice.cookie, body, ...extra });
const sync = (id = box.id) => h.request(`/api/v1/mailboxes/${id}/sync`, { method: "POST", cookie: alice.cookie, body: {} });
before(async () => {
  f = await providerFixture(); h = await createHarness(f.bindings);
  alice = await h.register("organize-alice"); bob = await h.register("organize-bob");
  box = (await allocate(h, alice.cookie)).body.mailbox;
  other = (await allocate(h, bob.cookie)).body.mailbox;
  f.messages.set(box.address, [cfMail(box.address, 1)]);
  assert.equal((await sync()).status, 200);
  message = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items[0];
});
beforeEach(async () => h.resetLimits());
after(async () => { await h?.close(); await f?.close(); });

test("mailbox partial edits persist without changing address, provider identity or remote resources", async () => {
  const calls = f.calls.length;
  const first = await patchBox({ displayName: "项目邮箱", note: "保留备注\n第二行", favorite: true });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.mailbox.displayName, "项目邮箱");
  assert.equal(first.body.mailbox.favorite, true);
  const second = await patchBox({ note: "更新备注" });
  assert.equal(second.body.mailbox.displayName, "项目邮箱");
  assert.equal(second.body.mailbox.note, "更新备注");
  assert.equal(second.body.mailbox.address, box.address);
  assert.equal(second.body.mailbox.providerId, box.providerId);
  assert.equal(f.calls.length, calls);
});

test("message flags are explicit idempotent assignments and do not mutate provider content", async () => {
  const calls = f.calls.length;
  const result = await patchMessage({ isRead: true, starred: true, archived: true });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body.state, { id: message.id, isRead: true, starred: true, archived: true });
  assert.equal((await patchMessage({ isRead: true })).body.state.starred, true);
  assert.equal((await patchMessage({ archived: false })).body.state.isRead, true);
  assert.equal(f.calls.length, calls);
  assert.equal((await sync()).body.sync.inserted, 0);
  const detail = await h.request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`, { cookie: alice.cookie });
  assert.equal(detail.body.message.starred, true);
  assert.equal(detail.body.message.textBody, "Your verification code is 654321.");
});

test("state writes enforce owner, separate write scopes, Origin and strict patch schemas", async () => {
  const count = f.calls.length;
  const readOnly = await newKey(h, alice.cookie, { scopes: ["messages:read", "mailboxes:read"] });
  assert.equal((await patchBox({ favorite: false }, { token: readOnly.token })).status, 403);
  assert.equal((await patchMessage({ starred: false }, { token: readOnly.token })).status, 403);
  assert.equal((await patchBox({ favorite: false }, { cookie: bob.cookie })).status, 404);
  assert.equal((await patchMessage({ starred: false }, { cookie: bob.cookie })).status, 404);
  assert.equal((await patchMessage({ starred: false }, { origin: null })).status, 403);
  assert.equal((await patchBox({ favorite: false }, { origin: "https://attacker.test" })).status, 403);
  for (const body of [{}, { favorite: "true" }, { displayName: "x".repeat(81) }, { note: "x".repeat(1001) }, { address: other.address }, { status: "active" }]) {
    assert.equal((await patchBox(body)).status, 400);
  }
  for (const body of [{}, { isRead: 1 }, { remoteId: "victim" }, { userId: bob.id }, { deleted: true }]) assert.equal((await patchMessage(body)).status, 400);
  const writer = await newKey(h, alice.cookie, { scopes: ["messages:write"] });
  assert.equal((await patchMessage({ starred: true }, { cookie: null, token: writer.token, origin: null })).status, 200);
  assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/messages`, { token: writer.token })).status, 403);
  assert.equal((await patchBox({ favorite: true }, { token: writer.token })).status, 403);
  assert.equal(f.calls.length, count);
});

test("a repeated no-op resume does not cancel a new in-flight sync", async () => {
  const gate = f.hold("/cf/api/parsed_mails");
  const pending = sync();
  try {
    await gate.entered;
    assert.equal((await patchBox({ paused: false })).status, 200);
  } finally { gate.release(); }
  assert.equal((await pending).status, 200);
});

test("pause cancels in-flight sync and resume preserves address, credential and cached messages", async () => {
  const before = await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id = ?").bind(box.id).first();
  const gate = f.hold("/cf/api/parsed_mails");
  f.messages.get(box.address).push(cfMail(box.address, 2));
  const pending = sync();
  try {
    await gate.entered;
    assert.equal((await patchBox({ paused: true })).body.mailbox.paused, true);
  } finally { gate.release(); }
  const stale = await pending;
  assert.equal(stale.status, 409, stale.text);
  const calls = f.calls.length;
  assert.equal((await sync()).body.error.code, "mailbox_paused");
  assert.equal(f.calls.length, calls);
  assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items.length, 1);
  assert.equal((await patchBox({ paused: false })).body.mailbox.address, box.address);
  assert.equal((await sync()).body.sync.inserted, 1);
  const after = await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id = ?").bind(box.id).first();
  assert.equal(after.credential_cipher, before.credential_cipher);
  await h.restart();
  const row = (await h.request(`/api/v1/mailboxes/${box.id}`, { cookie: alice.cookie })).body.mailbox;
  assert.equal(row.favorite, true);
  assert.equal(row.note, "更新备注");
  assert.equal(row.paused, false);
});
