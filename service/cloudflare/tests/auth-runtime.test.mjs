import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHash } from "node:crypto";
import { createHarness, INVITE, newKey, ORIGIN, PASSWORD, seedMailbox } from "./runtime-harness.mjs";

let h;
let alice;
let bob;
let aliceMailbox;
let bobMailbox;

before(async () => {
  h = await createHarness();
  alice = await h.register("alice");
  bob = await h.register("bob");
  aliceMailbox = await seedMailbox(h, alice.id, "alice@example.test");
  bobMailbox = await seedMailbox(h, bob.id, "bob@example.test");
});
beforeEach(async () => h.resetLimits());
after(async () => { if (h) await h.close(); });

test("registration runs OWASP scrypt in workerd, matches independent Node KDF and stores no raw session", async () => {
  const hash = await h.comparePassword("alice");
  const bobHash = await h.comparePassword("bob");
  assert.notEqual(hash, bobHash);
  const token = alice.cookie.split("=")[1];
  const stored = await h.db.prepare("SELECT token_hash FROM sessions WHERE user_id = ?").bind(alice.id).first();
  assert.equal(stored.token_hash, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(stored.token_hash, token);
});

test("login survives real HTTP and sets hardened host-only cookie", async () => {
  const response = await h.request("/api/v1/auth/login", { method: "POST", body: { username: "ALICE", password: PASSWORD } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.user.id, alice.id);
  const cookie = response.headers.get("set-cookie");
  for (const attribute of ["__Host-ee_session=", "Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=604800"]) {
    assert.ok(cookie.includes(attribute), attribute);
  }
  assert.equal(cookie.includes("Domain="), false);
  const me = await h.request("/api/v1/me", { cookie: response.cookie });
  assert.equal(me.body.user.id, alice.id);
  assert.equal(me.headers.get("cache-control"), "no-store");
});

test("unknown, wrong-password and disabled accounts share invalid_credentials", async () => {
  for (const username of ["alice", "missing-user"]) {
    const result = await h.request("/api/v1/auth/login", { method: "POST", body: { username, password: "definitely-wrong-password" } });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, "invalid_credentials");
  }
  await h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(bob.id).run();
  try {
    const result = await h.request("/api/v1/auth/login", { method: "POST", body: { username: "bob", password: PASSWORD } });
    assert.equal(result.status, 401);
    assert.equal((await h.request("/api/v1/me", { cookie: bob.cookie })).status, 401);
  } finally {
    await h.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(bob.id).run();
  }
});

test("registration is invite-protected and rejects duplicate usernames without partial sessions", async () => {
  const before = await h.db.prepare("SELECT COUNT(*) AS n FROM sessions").first();
  const bad = await h.request("/api/v1/auth/register", { method: "POST", body: { username: "charlie", password: PASSWORD, invite: "wrong" } });
  assert.equal(bad.status, 403);
  const duplicate = await h.request("/api/v1/auth/register", { method: "POST", body: { username: "ALICE", password: PASSWORD, invite: INVITE } });
  assert.equal(duplicate.status, 409, duplicate.text);
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n, before.n);
});

test("browser writes reject absent and hostile origins before changing state", async () => {
  for (const origin of [null, "https://attacker.example", `${ORIGIN}.attacker.example`]) {
    const response = await h.request("/api/v1/api-keys", { method: "POST", cookie: alice.cookie, origin,
      body: { name: "forbidden", scopes: ["mailboxes:read"] } });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "origin_denied");
    assert.equal((await h.request("/api/v1/auth/login", { method: "POST", origin, body: { username: "alice", password: PASSWORD } })).status, 403);
  }
});

test("mailbox list and detail enforce owner on every query and never restore access by address", async () => {
  const list = await h.request("/api/v1/mailboxes", { cookie: alice.cookie });
  assert.deepEqual(list.body.items.map((item) => item.id), [aliceMailbox]);
  assert.equal(list.text.includes("remote_id"), false);
  assert.equal((await h.request(`/api/v1/mailboxes/${aliceMailbox}`, { cookie: alice.cookie })).status, 200);
  const other = await h.request(`/api/v1/mailboxes/${bobMailbox}`, { cookie: alice.cookie });
  const absent = await h.request(`/api/v1/mailboxes/${crypto.randomUUID()}`, { cookie: alice.cookie });
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, absent.body.error.code);
  assert.equal((await h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie, body: { address: "bob@example.test" } })).status, 400);
});

test("key is returned once, stored hashed and cannot manage credentials or another user's mailbox", async () => {
  const key = await newKey(h, alice.cookie);
  const row = await h.db.prepare("SELECT token_hash FROM api_keys WHERE id = ?").bind(key.id).first();
  assert.equal(row.token_hash, createHash("sha256").update(key.token).digest("hex"));
  const listed = await h.request("/api/v1/api-keys", { cookie: alice.cookie });
  assert.equal(listed.text.includes(key.token), false);
  assert.equal(listed.text.includes("token_hash"), false);
  assert.equal((await h.request("/api/v1/mailboxes", { token: key.token, origin: null })).status, 200);
  assert.equal((await h.request(`/api/v1/mailboxes/${bobMailbox}`, { token: key.token })).status, 404);
  assert.equal((await h.request("/api/v1/api-keys", { token: key.token, cookie: alice.cookie })).status, 403);
  assert.equal((await h.request("/api/v1/api-keys", { method: "POST", token: key.token, cookie: alice.cookie, body: {} })).status, 403);
  assert.equal((await h.request(`/api/v1/api-keys/${key.id}`, { method: "DELETE", cookie: bob.cookie })).status, 404);
  assert.equal((await h.request(`/api/v1/api-keys/${key.id}`, { method: "DELETE", cookie: alice.cookie })).status, 200);
  assert.equal((await h.request(`/api/v1/api-keys/${key.id}`, { method: "DELETE", cookie: alice.cookie })).status, 200);
  assert.equal((await h.request("/api/v1/me", { token: key.token, cookie: alice.cookie })).status, 401);
});

test("scope enforcement, expiry, disabled users and malformed bearer fail closed", async () => {
  const key = await newKey(h, alice.cookie);
  await h.db.prepare("UPDATE api_keys SET scopes = '[]' WHERE id = ?").bind(key.id).run();
  assert.equal((await h.request("/api/v1/mailboxes", { token: key.token })).status, 403);
  await h.db.prepare("UPDATE api_keys SET expires_at = 1 WHERE id = ?").bind(key.id).run();
  assert.equal((await h.request("/api/v1/me", { token: key.token })).status, 401);
  for (const token of ["", "wrong", "es_" + "a".repeat(64)]) {
    assert.equal((await h.request("/api/v1/me", { token, cookie: alice.cookie })).status, 401);
  }
  const second = await newKey(h, bob.cookie);
  await h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(bob.id).run();
  try { assert.equal((await h.request("/api/v1/me", { token: second.token })).status, 401); }
  finally { await h.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(bob.id).run(); }
});

test("logout revokes persisted session and expiration cannot be bypassed by old cookie", async () => {
  const login = await h.request("/api/v1/auth/login", { method: "POST", body: { username: "alice", password: PASSWORD } });
  const response = await h.request("/api/v1/auth/logout", { method: "POST", cookie: login.cookie });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));
  assert.equal((await h.request("/api/v1/me", { cookie: login.cookie })).status, 401);
  const expired = await h.request("/api/v1/auth/login", { method: "POST", body: { username: "alice", password: PASSWORD } });
  const hash = createHash("sha256").update(expired.cookie.split("=")[1]).digest("hex");
  await h.db.prepare("UPDATE sessions SET expires_at = 1 WHERE token_hash = ?").bind(hash).run();
  assert.equal((await h.request("/api/v1/me", { cookie: expired.cookie })).status, 401);
});

test("D1 survives workerd restart with user/session/key/resource ownership intact", async () => {
  const key = await newKey(h, alice.cookie);
  await h.restart();
  assert.equal((await h.request("/api/v1/me", { cookie: alice.cookie })).body.user.id, alice.id);
  const response = await h.request("/api/v1/mailboxes", { token: key.token });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map((item) => item.id), [aliceMailbox]);
  assert.equal((await h.request(`/api/v1/mailboxes/${bobMailbox}`, { token: key.token })).status, 404);
  console.log(`Isolated persistent D1 evidence: ${h.directory}`);
});
