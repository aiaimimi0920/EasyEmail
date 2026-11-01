import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate, providerFixture } from "./provider-fixture.mjs";
import { attachmentMail, binaryRequest, bytesHash, downloadPath } from "./attachment-fixture.mjs";

let h, f, alice, bob, box, message, fixture;
const sync = () => h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} });
before(async () => {
  f = await providerFixture(); h = await createHarness(f.bindings);
  alice = await h.register("attachment-alice"); bob = await h.register("attachment-bob");
  box = (await allocate(h, alice.cookie)).body.mailbox;
  fixture = attachmentMail(box.address); f.messages.set(box.address, [fixture.parsed]); f.rawMails.set(box.address, [fixture.raw]);
  assert.equal((await sync()).status, 200);
  message = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items[0];
});
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); });
after(async () => { await h?.close(); await f?.close(); });

test("only explicit download fetches raw MIME; authenticated binary response matches cached digest and is not inline", async () => {
  const calls = f.calls.length;
  const detail = await h.request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`, { cookie: alice.cookie });
  assert.equal(detail.body.message.attachments[0].downloadAvailable, true);
  assert.equal(f.calls.length, calls, "Reading cached details must not fetch raw MIME");
  const result = await binaryRequest(h, downloadPath(box, message), alice.cookie);
  assert.equal(result.status, 200, result.bytes.toString()); assert.deepEqual(result.bytes, fixture.bytes);
  assert.equal(result.headers.get("content-type"), "application/octet-stream");
  assert.match(result.headers.get("content-disposition"), /^attachment; /);
  assert.match(result.headers.get("content-disposition"), /filename\*=UTF-8''/);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  const call = f.calls.at(-1);
  assert.equal(call.path, "/cf/api/mail/71"); assert.equal(call.headers["x-admin-auth"], undefined);
  assert.match(call.headers.authorization, /^Bearer synthetic-mail-jwt-/);
});

test("download has a new independent scope, owner binding and bounded index; rejects before provider access", async () => {
  const read = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
  const writer = await newKey(h, alice.cookie, { scopes: ["attachments:read"] });
  const calls = f.calls.length;
  assert.equal((await binaryRequest(h, downloadPath(box, message), alice.cookie, { authorization: `Bearer ${read.token}` })).status, 403);
  assert.equal((await binaryRequest(h, downloadPath(box, message), bob.cookie)).status, 404);
  assert.equal((await binaryRequest(h, downloadPath(box, message, 100), alice.cookie)).status, 404);
  assert.equal(f.calls.length, calls);
  assert.equal((await binaryRequest(h, downloadPath(box, message), "", { authorization: `Bearer ${writer.token}` })).status, 200);
  assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`, { token: writer.token })).status, 403);
});

test("upstream missing, mismatched recipient, reused ID and changed bytes never return unverified attachments", async () => {
  for (const raw of [null, { ...fixture.raw, address: "victim@example.test" }, { ...fixture.raw, id: 999 },
    attachmentMail(box.address, Buffer.from("changed attachment content")).raw]) {
    f.rawMails.set(box.address, raw ? [raw] : []);
    const response = await binaryRequest(h, downloadPath(box, message), alice.cookie);
    assert.ok([404, 409, 502].includes(response.status), `${response.status}: ${response.bytes}`);
    assert.match(response.headers.get("content-type"), /application\/json/);
  }
  f.rawMails.set(box.address, [fixture.raw]);
});

test("binary-only changes create a new cache version and preserve old message flags and digest", async () => {
  await h.request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`, { method: "PATCH", cookie: alice.cookie, body: { starred: true } });
  const next = attachmentMail(box.address, Buffer.from("same-size binary bytes"));
  const initial = attachmentMail(box.address, Buffer.from("same-size binary test!"));
  assert.equal(next.bytes.length, initial.bytes.length);
  f.messages.set(box.address, [initial.parsed]); f.rawMails.set(box.address, [initial.raw]);
  assert.equal((await sync()).body.sync.inserted, 1);
  f.messages.set(box.address, [next.parsed]); f.rawMails.set(box.address, [next.raw]);
  assert.equal((await sync()).body.sync.inserted, 1);
  assert.equal((await sync()).body.sync.inserted, 0);
  const rows = (await h.db.prepare("SELECT * FROM messages WHERE mailbox_id = ?").bind(box.id).all()).results;
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.id === message.id).starred, 1);
  assert.equal(JSON.parse(rows.find((row) => row.id === message.id).attachments)[0].sha256, bytesHash(fixture.bytes));
  assert.equal((await binaryRequest(h, downloadPath(box, message), alice.cookie)).status, 409);
  const current = rows.find((row) => JSON.parse(row.attachments)[0].sha256 === bytesHash(next.bytes));
  assert.deepEqual((await binaryRequest(h, downloadPath(box, current), alice.cookie)).bytes, next.bytes);
});

test("redirect, malformed, oversized and timeout raw responses fail closed without retries", async () => {
  for (const mode of ["redirect", "invalid", "raw-oversized", 500]) {
    f.modes.set("/cf/api/mail/71", mode);
    const calls = f.calls.length;
    const result = await binaryRequest(h, downloadPath(box, message), alice.cookie);
    assert.equal(result.status, 502, result.bytes.toString()); assert.equal(f.calls.length, calls + 1);
  }
  f.modes.clear(); await h.resetLimits(); f.rawMails.set(box.address, [fixture.raw]);
  const gate = f.hold("/cf/api/mail/71"), pending = binaryRequest(h, downloadPath(box, message), alice.cookie);
  try { await gate.entered; await new Promise((resolve) => setTimeout(resolve, 15300)); }
  finally { gate.release(); }
  assert.equal((await pending).status, 502);
});
