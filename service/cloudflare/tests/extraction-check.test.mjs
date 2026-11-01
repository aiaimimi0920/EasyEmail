import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate, cfMail, providerFixture } from "./provider-fixture.mjs";

let h, fixture, alice, bob;
const now = () => Math.floor(Date.now() / 1000);
const time = (seconds) => new Date(seconds * 1000).toISOString();
const reads = () => fixture.calls.filter((call) => call.path === "/cf/api/parsed_mails");
const check = (mailbox, body, extra = {}) => h.request(`/api/v1/mailboxes/${mailbox.id}/extractions/check`,
  { method: "POST", cookie: alice.cookie, body, ...extra });
const fresh = async () => {
  const response = await allocate(h, alice.cookie);
  assert.equal(response.status, 201, response.text);
  return response.body.mailbox;
};
before(async () => {
  fixture = await providerFixture(); h = await createHarness(fixture.bindings);
  alice = await h.register("check-alice"); bob = await h.register("check-bob");
});
beforeEach(async () => { await h.resetLimits(); fixture.modes.clear(); });
after(async () => { await h?.close(); await fixture?.close(); });

test("existing extraction GET stays cache-only, bounded, fresh and owner-scoped", async () => {
  const box = await fresh(), since = now() - 5;
  fixture.messages.set(box.address, [cfMail(box.address, 1, "Your verification code is 512893.", time(since))]);
  const route = `/api/v1/mailboxes/${box.id}/extractions?since=${since}`;
  const before = reads().length;
  assert.deepEqual((await h.request(route, { cookie: alice.cookie })).body.items, []);
  assert.equal(reads().length, before);
  assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} })).status, 200);
  const result = await h.request(route, { cookie: alice.cookie });
  assert.equal(result.body.items[0].otp.code, "512893");
  assert.deepEqual(result.body.items[0].links.map((item) => item.url), ["https://auth.example.test/verify?token=synthetic"]);
  assert.equal((await h.request(route, { cookie: bob.cookie })).status, 404);
  assert.equal((await h.request(route.replace(String(since), String(now() + 120)), { cookie: alice.cookie })).status, 400);
});

test("one check reads one page and returns honest waiting/matched with pinned filters", async () => {
  const box = await fresh(), since = now() - 3;
  const input = { since, sender: "NOREPLY", subject: "verify", recipient: box.address, kind: "otp" };
  const old = cfMail(box.address, 1, "Your verification code is 111222.", time(since - 10));
  const unknown = cfMail(box.address, 2, "Your verification code is 222333.", "not-a-date");
  const future = cfMail(box.address, 3, "Your verification code is 333444.", time(now() + 300));
  const wrong = { ...cfMail(box.address, 4, "Your verification code is 444555.", time(since)), sender: "other@example.test" };
  fixture.messages.set(box.address, [old, unknown, future, wrong]);
  const before = reads().length;
  const waiting = await check(box, input);
  assert.equal(waiting.status, 200, waiting.text);
  assert.equal(waiting.body.state, "waiting");
  assert.equal(waiting.body.retryAfterSeconds, 5);
  assert.deepEqual(waiting.body.items, []);
  assert.equal(reads().length, before + 1);
  fixture.messages.get(box.address).unshift(cfMail(box.address, 5, "Your verification code is 645897.", time(since)));
  const matched = await check(box, input);
  assert.equal(matched.body.state, "matched");
  assert.equal(matched.body.retryAfterSeconds, null);
  assert.equal(matched.body.items[0].otp.code, "645897");
  assert.equal(matched.body.sync.complete, true);
  assert.equal(reads().length, before + 2);
  assert.equal(matched.text.includes("synthetic-mail-jwt"), false);
});

test("OTP/link targets are independent and cache search truncation is explicit", async () => {
  const box = await fresh(), since = now() - 3;
  const link = cfMail(box.address, 1, "Follow the link.", time(since));
  fixture.messages.set(box.address, [link]);
  assert.equal((await check(box, { since, kind: "otp" })).body.state, "waiting");
  const result = await check(box, { since, kind: "link" });
  assert.equal(result.body.state, "matched");
  assert.equal(result.body.items[0].otp, null);
  assert.equal(result.body.items[0].links.length, 1);
  const row = await h.db.prepare("SELECT * FROM messages WHERE mailbox_id=? LIMIT 1").bind(box.id).first();
  const inserts = Array.from({ length: 105 }, (_, i) => h.db.prepare(`INSERT INTO messages
    (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), alice.id, box.id, `scan-${i}`, `fp-${i}`,
    row.sender, box.address, "No match", "Nothing here", "", "[]", since + 1, since + 1));
  await h.db.batch(inserts);
  const limited = await check(box, { since, kind: "otp" });
  assert.equal(limited.body.state, "waiting");
  assert.equal(limited.body.searchLimited, true);
  assert.equal(limited.body.searched, 100);
});

test("authorization, Origin and all filters validate before any provider reads", async () => {
  const box = await fresh(), since = now() - 1;
  const read = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
  const write = await newKey(h, alice.cookie, { scopes: ["mailboxes:write"] });
  const both = await newKey(h, alice.cookie, { scopes: ["messages:read", "mailboxes:write"] });
  const before = reads().length;
  for (const extra of [{ token: read.token }, { token: write.token }, { origin: null }, { origin: "https://attacker.invalid" }]) {
    assert.equal((await check(box, { since }, extra)).status, 403);
  }
  assert.equal((await check(box, { since }, { cookie: bob.cookie })).status, 404);
  for (const body of [{}, { since: 0 }, { since: now() + 1000 }, { since, kind: "all" }, { since, kind: null }, { since, sender: 9 },
    { since, subject: "x".repeat(257) }, { since, recipient: "victim@example.test" }, { since, page: 8 },
    { since, page: null }, { since, timeout: 999 }]) {
    const result = await check(box, body);
    assert.equal(result.status, 400, result.text);
  }
  assert.equal(reads().length, before);
  assert.equal((await check(box, { since }, { token: both.token, origin: null })).status, 200);
});

test("page continuation is bounded; upstream failure never falls back to a cached success", async () => {
  const box = await fresh(), since = now() - 2;
  fixture.messages.set(box.address, Array.from({ length: 11 }, (_, i) => ({
    ...cfMail(box.address, i + 1, i === 10 ? "Your verification code is 785423." : "Notice", time(since)), html: "",
  })));
  const before = reads().length;
  const first = await check(box, { since, kind: "otp" });
  assert.equal(first.body.state, "waiting"); assert.equal(first.body.sync.nextPage, 2);
  assert.equal(first.body.sync.complete, false); assert.equal(reads().length, before + 1);
  const second = await check(box, { since, kind: "otp", page: 2 });
  assert.equal(second.body.state, "matched"); assert.equal(second.body.sync.nextPage, null);
  assert.equal(reads().length, before + 2);
  fixture.modes.set("/cf/api/parsed_mails", 401);
  const failure = await check(box, { since });
  assert.equal(failure.status, 502); assert.equal(failure.body.error.code, "provider_auth_failed");
  assert.equal(failure.text.includes("do-not-leak"), false);
});

test("paused, disabled, released and expired mailboxes stop checks without external access", async () => {
  const box = await fresh(), since = now() - 1;
  const before = reads().length;
  for (const [sql, code] of [["paused=1", "mailbox_paused"], ["disabled_at=unixepoch()", "mailbox_disabled"],
    ["released_at=unixepoch()", "mailbox_released"], ["expires_at=unixepoch()-1", "mailbox_expired"]]) {
    await h.db.prepare(`UPDATE mailboxes SET paused=0,disabled_at=NULL,released_at=NULL,expires_at=NULL,${sql} WHERE id=?`).bind(box.id).run();
    assert.equal((await check(box, { since })).body.error.code, code);
  }
  assert.equal(reads().length, before);
});

test("check and explicit sync share the same lease and user rate budget", async () => {
  const box = await fresh(), since = now() - 1, gate = fixture.hold("/cf/api/parsed_mails");
  const pending = check(box, { since });
  try {
    await gate.entered;
    assert.equal((await check(box, { since })).body.error.code, "sync_in_progress");
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} })).body.error.code, "sync_in_progress");
  } finally { gate.release(); }
  assert.equal((await pending).status, 200);
  await h.resetLimits();
  assert.equal((await check(box, { since })).status, 200);
  await h.db.prepare("UPDATE auth_rate_limits SET attempts=20").run();
  const before = reads().length;
  assert.equal((await check(box, { since })).status, 429);
  assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} })).status, 429);
  assert.equal(reads().length, before);
  console.log(`M3i runtime evidence: ${h.directory}`);
});
