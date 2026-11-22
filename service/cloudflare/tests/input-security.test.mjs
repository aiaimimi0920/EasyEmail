import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createHarness, INVITE, newKey, ORIGIN, PASSWORD, seedMailbox } from "./runtime-harness.mjs";

let h;
let user;
before(async () => { h = await createHarness(); user = await h.register("input-user"); });
beforeEach(async () => h.resetLimits());
after(async () => { if (h) await h.close(); });

test("unknown API never falls back to Web HTML; errors and methods are explicit JSON", async () => {
  for (const route of ["/api/v1/not-implemented", "/api/v1/mailboxes/not-a-valid-id", "/api/v2/me"]) {
    const response = await h.request(route);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not_found");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal((await h.request("/api/v1/auth/login")).status, 405);
  assert.equal((await h.request("/api/v1/mailboxes")).status, 401);
  const health = await h.request("/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "alive");
});

test("JSON, size and username/password validation happen before credential storage", async () => {
  const inputs = [
    { body: "{" }, { body: "[]" }, { body: "null" },
    { body: { username: "short", password: "short", invite: INVITE } },
    { body: { username: "bad'name", password: PASSWORD, invite: INVITE } },
    { body: { username: ["array"], password: PASSWORD, invite: INVITE } },
  ];
  for (const input of inputs) {
    assert.equal((await h.request("/api/v1/auth/register", { method: "POST", ...input })).status, 400);
  }
  const wrongType = await h.request("/api/v1/auth/login", { method: "POST", body: "username=input-user", headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
  const tooLarge = await h.request("/api/v1/auth/login", { method: "POST", body: "x".repeat(8193) });
  assert.equal(tooLarge.status, 413);
});

test("cookie duplicates and invalid Authorization never fall back to a valid session", async () => {
  assert.equal((await h.request("/api/v1/me", { cookie: `${user.cookie}; ${user.cookie}` })).status, 401);
  for (const authorization of ["Basic invalid", "Bearer wrong", "Bearer"]) {
    assert.equal((await h.request("/api/v1/me", { cookie: user.cookie, headers: { authorization } })).status, 401, authorization);
  }
});

test("streaming JSON without content-length is still bounded to eight KiB", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)); controller.close(); } });
  const response = await fetch(new URL("/api/v1/auth/login", h.baseUrl), {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, connection: "close" },
    body, duplex: "half", signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "body_too_large");
});

test("new login prunes old sessions to twenty without revoking the just-created session", async () => {
  const owner = await h.register("session-quota-user");
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 24; i++) {
    await h.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, NULL)")
      .bind(`quota-fixture-${i}`, owner.id, now - 100, now + 600).run();
  }
  const login = await h.request("/api/v1/auth/login", { method: "POST", body: { username: owner.username, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(owner.id).first()).n, 20);
  assert.equal((await h.request("/api/v1/me", { cookie: login.cookie })).status, 200);
});

test("key input rejects arbitrary scopes, indefinite expiry and empty names", async () => {
  for (const input of [
    { scopes: ["*"] }, { scopes: ["mailboxes:admin"] }, { scopes: [] }, { scopes: ["mailboxes:read", "mailboxes:read"] },
    { scopes: "mailboxes:read" }, { name: " " }, { expiresInSeconds: 0 }, { expiresInSeconds: 90 * 86400 + 1 },
    { expiresInSeconds: "600" },
  ]) {
    const response = await h.request("/api/v1/api-keys", { method: "POST", cookie: user.cookie,
      body: { name: "invalid", scopes: ["mailboxes:read"], ...input } });
    assert.equal(response.status, 400, response.text);
  }
});

test("keyset pagination validates limits and never includes another user's resource", async () => {
  const other = await h.register("pagination-other");
  const owned = [];
  for (let i = 0; i < 3; i++) owned.push(await seedMailbox(h, user.id, `own${i}@example.test`));
  await seedMailbox(h, other.id, "other@example.test");
  let cursor = "";
  const seen = [];
  do {
    const page = await h.request(`/api/v1/mailboxes?limit=1&cursor=${cursor}`, { cookie: user.cookie });
    assert.equal(page.status, 200);
    seen.push(...page.body.items.map((item) => item.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(seen.sort(), owned.sort());
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=-1", "cursor=invalid"]) {
    assert.equal((await h.request(`/api/v1/mailboxes?${query}`, { cookie: user.cookie })).status, 400);
  }
  for (let i = 0; i < 3; i++) await newKey(h, user.cookie);
  const page = await h.request("/api/v1/api-keys?limit=1", { cookie: user.cookie });
  assert.equal(page.body.items.length, 1);
  assert.ok(page.body.nextCursor);
});

test("parallel key creation cannot exceed twenty active keys", async () => {
  const owner = await h.register("key-quota-user");
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => h.request("/api/v1/api-keys", {
    method: "POST", cookie: owner.cookie, body: { name: `key-${i}`, scopes: ["mailboxes:read"] },
  })));
  assert.equal(results.filter((result) => result.status === 201).length, 20);
  assert.equal(results.filter((result) => result.status === 409).length, 4);
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?").bind(owner.id).first()).n, 20);
});

test("login account throttling is atomic, survives restart and returns retry-after", async () => {
  const remaining = 60000 - Date.now() % 60000;
  if (remaining < 10000) await setTimeout(remaining + 50);
  const minute = Math.floor(Date.now() / 60000);
  const accountBucket = (window) => createHash("sha256").update(`auth-account:${window}:no-such-account`).digest("hex");
  const attempts = await Promise.all(Array.from({ length: 7 }, () => h.request("/api/v1/auth/login", {
    method: "POST", body: { username: "no-such-account", password: PASSWORD },
  })));
  assert.equal(attempts.filter((result) => result.status === 401).length, 5);
  assert.equal(attempts.filter((result) => result.status === 429).length, 2);
  assert.equal(attempts.find((result) => result.status === 429).headers.get("retry-after"), "60");
  const counters = (await h.db.prepare("SELECT * FROM auth_rate_limits ORDER BY bucket").all()).results;
  assert.equal(counters.find((row) => row.bucket === accountBucket(minute)).attempts, 7);
  await h.restart();
  assert.deepEqual((await h.db.prepare("SELECT * FROM auth_rate_limits ORDER BY bucket").all()).results, counters);
  const blocked = await h.request("/api/v1/auth/login", { method: "POST", body: { username: "no-such-account", password: PASSWORD } });
  const after = (await h.db.prepare("SELECT * FROM auth_rate_limits").all()).results;
  const incremented = after.find((row) => [accountBucket(minute), accountBucket(minute + 1)].includes(row.bucket)
    && row.attempts !== counters.find((old) => old.bucket === row.bucket)?.attempts);
  assert.ok(incremented, "The request must increment the original or next minute account bucket");
  assert.ok([1, 8].includes(incremented.attempts));
  assert.equal(blocked.status, incremented.attempts === 8 ? 429 : 401);
});

test("scheduled cleanup deletes only expired identities and counters", async () => {
  await h.db.prepare("INSERT INTO auth_rate_limits VALUES ('expired-fixture', 1, 1)").run();
  await h.db.prepare("INSERT INTO sessions VALUES ('expired-fixture', ?, 0, 1, NULL)").bind(user.id).run();
  const result = await h.scheduled();
  assert.equal(result.outcome, "ok");
  assert.equal(await h.db.prepare("SELECT * FROM sessions WHERE token_hash = 'expired-fixture'").first(), null);
  assert.equal(await h.db.prepare("SELECT * FROM auth_rate_limits WHERE bucket = 'expired-fixture'").first(), null);
  assert.equal((await h.request("/api/v1/me", { cookie: user.cookie })).status, 200);
});

test("missing or weak registration secret closes registration without affecting health", async () => {
  const closed = await createHarness({ REGISTRATION_TOKEN: "" });
  try {
    const response = await closed.request("/api/v1/auth/register", { method: "POST", body: { username: "closed", password: PASSWORD, invite: INVITE } });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "registration_closed");
    assert.equal((await closed.request("/healthz")).status, 200);
  } finally { await closed.close(); }
});
