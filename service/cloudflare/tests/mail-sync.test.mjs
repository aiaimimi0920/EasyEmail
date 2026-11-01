import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate, cfMail, providerFixture } from "./provider-fixture.mjs";

let h, fixture, alice, bob, mailbox;
const sync = (id = mailbox.id, extra = {}) => h.request(`/api/v1/mailboxes/${id}/sync`,
  { method: "POST", cookie: alice.cookie, body: {}, ...extra });
const list = (id = mailbox.id, extra = {}) => h.request(`/api/v1/mailboxes/${id}/messages`, { cookie: alice.cookie, ...extra });
const extract = (query) => h.request(`/api/v1/mailboxes/${mailbox.id}/extractions?${query}`, { cookie: alice.cookie });
before(async () => { fixture = await providerFixture(); h = await createHarness(fixture.bindings);
  alice = await h.register("sync-alice"); bob = await h.register("sync-bob");
  const result = await allocate(h, alice.cookie); assert.equal(result.status, 201, result.text); mailbox = result.body.mailbox; });
beforeEach(async () => { await h.resetLimits(); fixture.modes.clear(); });
after(async () => { await h?.close(); await fixture?.close(); });

test("GET does not fetch mail; explicit sync caches parsed content, details, UTC time, OTP and absolute authentication links", async () => {
  fixture.messages.set(mailbox.address, [cfMail(mailbox.address, 1)]);
  const count = fixture.calls.length;
  assert.deepEqual((await list()).body.items, []);
  assert.equal(fixture.calls.length, count);
  const result = await sync();
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.sync.inserted, 1);
  assert.equal(result.body.sync.complete, true);
  const mails = await list();
  assert.equal(mails.body.items.length, 1);
  const message = mails.body.items[0];
  assert.equal(message.receivedAt, Date.parse("2026-10-28T01:00:00Z") / 1000);
  const detail = await h.request(`/api/v1/mailboxes/${mailbox.id}/messages/${message.id}`, { cookie: alice.cookie });
  assert.equal(detail.body.message.textBody, "Your verification code is 654321.");
  assert.equal(detail.body.message.attachmentDownloadAvailable, false);
  const otp = await extract("since=1793149199&sender=noreply&subject=verify");
  assert.equal(otp.status, 200, otp.text);
  assert.equal(otp.body.items[0].otp.code, "654321");
  assert.deepEqual(otp.body.items[0].links.map((link) => link.url), ["https://auth.example.test/verify?token=synthetic"]);
  assert.equal((await sync()).body.sync.inserted, 0);
  assert.equal((await list()).body.items.length, 1);
});

test("messages and sync reject cross-owner, missing and insufficient-scope access without external fetch", async () => {
  const message = (await list()).body.items[0];
  const count = fixture.calls.length;
  for (const id of [mailbox.id, crypto.randomUUID()]) {
    assert.equal((await list(id, { cookie: bob.cookie })).status, 404);
    assert.equal((await sync(id, { cookie: bob.cookie })).status, 404);
  }
  assert.equal((await h.request(`/api/v1/mailboxes/${mailbox.id}/messages/${message.id}`, { cookie: bob.cookie })).status, 404);
  const key = await newKey(h, alice.cookie);
  assert.equal((await list(mailbox.id, { token: key.token })).status, 403);
  assert.equal((await sync(mailbox.id, { token: key.token })).status, 403);
  assert.equal(fixture.calls.length, count);
  const reader = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
  assert.equal((await list(mailbox.id, { token: reader.token, origin: null })).status, 200);
});

test("bounded pages expose continuation and ignore Cloudflare's zero count on later pages", async () => {
  fixture.messages.set(mailbox.address, Array.from({ length: 12 }, (_, i) => cfMail(mailbox.address, 100 + i)));
  const first = await sync();
  assert.equal(first.body.sync.complete, false);
  assert.equal(first.body.sync.nextPage, 2);
  assert.equal((await sync(mailbox.id, { body: { page: 3 } })).status, 400);
  const second = await sync(mailbox.id, { body: { page: 2 } });
  assert.equal(second.body.sync.fetched, 2);
  assert.equal(second.body.sync.complete, true);
  assert.equal((await list()).body.items.length, 13);
});

test("upstream integer ID reuse does not overwrite historical mail", async () => {
  fixture.messages.set(mailbox.address, [cfMail(mailbox.address, 1, "Your verification code is 987654.")]);
  assert.equal((await sync()).body.sync.inserted, 1);
  assert.equal((await list()).body.items.length, 14);
});

test("freshness requires explicit since and known upstream receipt time; no old/unknown-time code fallback", async () => {
  fixture.messages.set(mailbox.address, [cfMail(mailbox.address, 200, "Your verification code is 111222.", "not-a-date")]);
  assert.equal((await sync()).status, 200);
  assert.equal((await extract("")).status, 400);
  assert.equal((await extract("since=1793152801")).body.items.length, 0);
  assert.equal((await extract("since=1&sender=not-the-sender")).body.items.length, 0);
  assert.equal((await extract("since=1&recipient=victim@example.test")).status, 400);
  assert.equal((await extract("since=99999999999")).status, 400);
});

test("auth, throttling, oversized, malformed and redirect failures preserve cache and sanitize errors", async () => {
  const size = (await list()).body.items.length;
  for (const mode of [401, 429, 500, "oversized", "invalid", "redirect"]) {
    fixture.modes.set("/cf/api/parsed_mails", mode);
    const result = await sync();
    assert.equal(result.status, 502, result.text);
    assert.equal(result.text.includes("do-not-leak"), false);
    const cached = await list();
    assert.equal(cached.body.items.length, size);
    assert.ok(cached.body.sync.error);
  }
  assert.equal(fixture.calls.some((call) => call.path === "/secret-exfiltration"), false);
});

test("concurrent sync uses lease and stale completion cannot write cache or release successor lease", async () => {
  const gate = fixture.hold("/cf/api/parsed_mails");
  const first = sync();
  try {
    await gate.entered;
    assert.equal((await sync()).body.error.code, "sync_in_progress");
    await h.db.prepare("UPDATE mailboxes SET sync_token = 'successor', sync_lease_until = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000) + 60, mailbox.id).run();
  } finally { gate.release(); }
  const result = await first;
  assert.equal(result.status, 409, result.text);
  assert.equal(result.body.error.code, "sync_lease_lost");
  const row = await h.db.prepare("SELECT sync_token FROM mailboxes WHERE id = ?").bind(mailbox.id).first();
  assert.equal(row.sync_token, "successor");
  await h.db.prepare("UPDATE mailboxes SET sync_token = NULL, sync_lease_until = 0 WHERE id = ?").bind(mailbox.id).run();
});

test("AES-GCM rejects credential swaps between mailboxes and D1 batch failure never partially updates mail cache", async () => {
  const other = (await allocate(h, alice.cookie)).body.mailbox;
  const cipher = (await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id = ?").bind(mailbox.id).first()).credential_cipher;
  await h.db.prepare("UPDATE mailboxes SET credential_cipher = ? WHERE id = ?").bind(cipher, other.id).run();
  const count = fixture.calls.length;
  const swapped = await sync(other.id);
  assert.equal(swapped.status, 503, swapped.text);
  assert.equal(fixture.calls.length, count);
  fixture.messages.set(mailbox.address, [cfMail(mailbox.address, 500)]);
  await h.db.prepare(`CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'synthetic cache failure'); END`).run();
  const size = (await list()).body.items.length;
  try { assert.equal((await sync()).body.error.code, "sync_storage_failed"); }
  finally { await h.db.prepare("DROP TRIGGER fail_message").run(); }
  assert.equal((await list()).body.items.length, size);
});

test("Temporam fetches v3 message details with encoded IDs, paginates and excludes old OTP results", async () => {
  const temp = (await allocate(h, alice.cookie, "temporam")).body.mailbox;
  fixture.messages.set(temp.address, Array.from({ length: 11 }, (_, i) => ({ id: `temp/${i}?`, toEmail: temp.address,
    fromEmail: "noreply@example.test", subject: i === 10 ? "Verify new" : "Notification",
    content: i === 10 ? "Your verification code is 313579." : "No code here", createdAt: "2026-10-28T01:00:00Z" })));
  const first = await sync(temp.id);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.sync.nextPage, 2);
  const second = await sync(temp.id, { body: { page: 2 } });
  assert.equal(second.body.sync.fetched, 1);
  const result = await h.request(`/api/v1/mailboxes/${temp.id}/extractions?since=1`, { cookie: alice.cookie });
  assert.equal(result.body.items[0].otp.code, "313579");
  await h.restart();
  assert.equal((await list(temp.id)).body.items.length, 11);
  console.log(`M2 sync evidence: ${h.directory}`);
});

test("missing detail on an early page remains visible at the end of traversal", async () => {
  const temp = (await allocate(h, alice.cookie, "temporam")).body.mailbox;
  fixture.messages.set(temp.address, Array.from({ length: 11 }, (_, i) => ({ id: `missing/${i}`, toEmail: temp.address,
    fromEmail: "notice@example.test", subject: "Notice", content: "No code here", createdAt: "2026-10-28T01:00:00Z" })));
  fixture.missingDetails.add("missing/0");
  try {
    const first = await sync(temp.id);
    assert.equal(first.body.sync.missing, 1);
    const last = await sync(temp.id, { body: { page: 2 } });
    assert.equal(last.body.sync.nextPage, null);
    assert.equal(last.body.sync.complete, false);
    assert.equal(last.body.sync.missing, 1);
    assert.equal((await list(temp.id)).body.sync.error, "upstream_messages_missing");
  } finally { fixture.missingDetails.clear(); }
  assert.equal((await sync(temp.id)).body.sync.missing, 0);
});

test("rotating vault key retains old readability; removing an old key fails closed", async () => {
  const ring = JSON.stringify({ active: "k2", keys: { k1: "a3".repeat(32), k2: "b4".repeat(32) } });
  try {
    await h.restart({ MAILBOX_KEYRING: ring });
    assert.equal((await sync()).status, 200);
    const newer = (await allocate(h, alice.cookie)).body.mailbox;
    const envelope = JSON.parse((await h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id = ?").bind(newer.id).first()).credential_cipher);
    assert.equal(envelope.key, "k2");
    await h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k2: "b4".repeat(32) } }) });
    assert.equal((await sync()).body.error.code, "mailbox_credential_unavailable");
    assert.equal((await sync(newer.id)).status, 200);
  } finally { await h.restart({ MAILBOX_KEYRING: ring }); }
});

test("read timeout is bounded, preserves cache and leaves a recoverable sync error", { timeout: 25000 }, async () => {
  const gate = fixture.hold("/cf/api/parsed_mails");
  const size = (await list()).body.items.length;
  const started = Date.now();
  const pending = sync();
  try {
    await gate.entered;
    const result = await pending;
    assert.equal(result.status, 502, result.text);
    assert.equal(result.body.error.code, "provider_timeout");
    assert.ok(Date.now() - started < 22000);
  } finally { gate.release(); }
  assert.equal((await list()).body.items.length, size);
  assert.equal((await sync()).status, 200);
});
