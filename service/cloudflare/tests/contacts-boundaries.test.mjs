import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { contactsFixture, contactBody, saveContact, contactWrite, getContact, expect } from "./contacts-fixture.mjs";

let f, h, alice, bob;
before(async () => { f = await contactsFixture(); ({ h, alice, bob } = f); });
beforeEach(async () => h.resetLimits()); after(async () => f?.close());

test("contact ownership, separate scopes, write Origin and receipt privacy are enforced by HTTP", async () => {
  const old = await newKey(h, alice.cookie, { scopes: ["messages:read", "messages:write"] });
  const read = await newKey(h, alice.cookie, { scopes: ["contacts:read"] });
  const write = await newKey(h, alice.cookie, { scopes: ["contacts:write"] });
  const manage = await newKey(h, alice.cookie, { scopes: ["contacts:read", "contacts:write"] });
  expect(await h.request("/api/v1/contacts"), 401); expect(await h.request("/api/v1/contacts", { token: old.token }), 403);
  expect(await saveContact(h, alice, contactBody(), undefined, { token: read.token }), 403);
  expect(await saveContact(h, alice, contactBody(), undefined, { token: write.token }), 403);
  expect(await saveContact(h, alice, contactBody(), undefined, { origin: null }), 403);
  expect(await saveContact(h, alice, contactBody(), undefined, { origin: "https://attacker.test" }), 403);
  const key = crypto.randomUUID(), result = expect(await saveContact(h, alice, contactBody(), key, { token: manage.token, origin: null }), 201), id = result.operation.contactId;
  expect(await getContact(h, alice, id, { token: read.token, origin: null }));
  expect(await getContact(h, bob, id), 404);
  expect(await contactWrite(h, bob, "PATCH", id, { expectedVersion: 1, note: "foreign" }), 404);
  expect(await contactWrite(h, bob, "DELETE", id, { expectedVersion: 1 }), 404);
  expect(await h.request(`/api/v1/contact-operations/${key}`, { cookie: bob.cookie }), 404);
  expect(await h.request(`/api/v1/contact-operations/${key}`, { token: read.token }), 403);
  const receipt = expect(await h.request(`/api/v1/contact-operations/${key}`, { token: manage.token, origin: null }));
  assert.equal(JSON.stringify(receipt).includes("alice@example.test"), false); assert.equal(JSON.stringify(receipt).includes("private note"), false);
  assert.notEqual(expect(await saveContact(h, bob), 201).operation.contactId, id);
  const stored = await h.db.prepare("SELECT scopes FROM api_keys WHERE id=?").bind(old.id).first("scopes"); assert.deepEqual(JSON.parse(stored), ["messages:read", "messages:write"]);
});

test("strict contact parsing rejects ambiguous addresses, unknown fields, invalid versions and oversized bodies", async () => {
  for (const body of [{}, contactBody("a@example.test,b@example.test"), contactBody("x@localhost"), contactBody("a@例子.test"),
    contactBody("Name <a@example.test> trailing"), contactBody("a@example.test\r\nX: injected"), contactBody("a@example.test", "x\u202ey"),
    contactBody("a@example.test", "x".repeat(81)), contactBody("a@example.test", "x", "n".repeat(2001)),
    { ...contactBody(), userId: bob.id }, { ...contactBody(), expectedVersion: 1 }]) expect(await saveContact(h, alice, body), 400);
  const id = expect(await saveContact(h, alice, contactBody("validation@example.test")), 201).operation.contactId;
  for (const body of [{ expectedVersion: 1 }, { expectedVersion: 0, note: "x" }, { expectedVersion: Number.MAX_SAFE_INTEGER, note: "x" },
    { expectedVersion: 1, emailAddress: null }, { expectedVersion: 1, displayName: null }]) expect(await contactWrite(h, alice, "PATCH", id, body), 400);
  expect(await contactWrite(h, alice, "DELETE", id, { expectedVersion: 1, note: "ignored?" }), 400);
  expect(await saveContact(h, alice, contactBody(), "invalid"), 400);
  expect(await saveContact(h, alice, { emailAddress: "a@example.test", note: "你".repeat(3000) }), 413);
  await h.db.prepare("UPDATE contacts SET version=? WHERE user_id=? AND id=?").bind(Number.MAX_SAFE_INTEGER, alice.id, id).run();
  expect(await saveContact(h, alice, contactBody("validation@example.test")), 409);
});

test("contact keyset pagination supports Unicode names and binds owner/search without leaking another user's rows", async () => {
  const user = await h.register("contacts-pagination");
  for (const [email, name] of [["a@example.test", "同名"], ["b@example.test", "同名"], ["z@example.test", "Zed"]]) expect(await saveContact(h, user, contactBody(email, name)), 201);
  const first = expect(await h.request("/api/v1/contacts?limit=1&q=同名", { cookie: user.cookie }));
  assert.equal(first.items[0].emailAddress, "a@example.test"); assert.ok(first.nextCursor);
  const next = expect(await h.request(`/api/v1/contacts?limit=1&q=同名&cursor=${first.nextCursor}`, { cookie: user.cookie }));
  assert.equal(next.items[0].emailAddress, "b@example.test"); assert.equal(next.nextCursor, null);
  expect(await h.request(`/api/v1/contacts?cursor=${first.nextCursor}`, { cookie: user.cookie }), 400);
  expect(await h.request(`/api/v1/contacts?q=同名&cursor=${first.nextCursor}`, { cookie: bob.cookie }), 400);
  for (const query of ["limit=0", "limit=101", "limit=1&limit=2", "q=x&q=y", "email=x", "cursor=broken"]) expect(await h.request(`/api/v1/contacts?${query}`, { cookie: user.cookie }), 400);
  expect(await h.request(`/api/v1/contacts/${first.items[0].id}?q=x`, { cookie: user.cookie }), 400);
});
