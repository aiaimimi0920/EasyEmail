import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { test } from "node:test";
import { accountFixture, accountSnapshot, passwordChange, login, ok } from "./account-fixture.mjs";
import { newKey, PASSWORD, seedMailbox } from "./runtime-harness.mjs";

const NEXT = "New-independent-password-378245";

test("password change independently matches scrypt and permanently revokes every existing session and Key", async () => {
  const a = await accountFixture(), { h, alice } = a;
  try {
    const box = await seedMailbox(h, alice.id, "password-preserved@example.test");
    const second = await login(h, alice), key = await newKey(h, alice.cookie);
    const oldHash = await h.comparePassword(alice.username);
    const changed = await passwordChange(h, alice, NEXT);
    assert.equal(ok(changed).reauthenticate, true); assert.match(changed.headers.get("set-cookie"), /Max-Age=0/);
    for (const cookie of [alice.cookie, second.cookie]) assert.equal((await h.request("/api/v1/me", { cookie })).status, 401);
    assert.equal((await h.request("/api/v1/me", { token: key.token })).status, 401);
    assert.equal((await login(h, alice)).status, 401);
    const fresh = await login(h, alice, NEXT); ok(fresh);
    assert.equal((await h.request(`/api/v1/mailboxes/${box}`, { cookie: fresh.cookie })).status, 200);
    const row = await h.db.prepare("SELECT password_hash FROM users WHERE id=?").bind(alice.id).first();
    const [algorithm, n, r, p, salt, expected] = row.password_hash.split("$");
    assert.equal(algorithm, "scrypt"); assert.notEqual(row.password_hash, oldHash);
    assert.equal(scryptSync(NEXT, salt, 32, { N: Number(n), r: Number(r), p: Number(p), maxmem: 33554432 }).toString("hex"), expected);
    const audit = await h.db.prepare("SELECT action,revision FROM account_audit WHERE user_id=?").bind(alice.id).first();
    assert.deepEqual(audit, { action: "password-change", revision: 1 });
    await h.restart();
    assert.equal((await h.request("/api/v1/me", { cookie: alice.cookie })).status, 401);
    assert.equal((await h.request("/api/v1/me", { cookie: fresh.cookie })).status, 200);
  } finally { await a.close(); }
});

test("password writes reject Keys, hostile origins, bad current passwords, unchanged and malformed input without changing credentials", async () => {
  const a = await accountFixture(), { h, alice } = a;
  try {
    const key = await newKey(h, alice.cookie), before = await accountSnapshot(h, alice.id);
    assert.equal((await h.request("/api/v1/account/password", { method: "POST", token: key.token,
      body: { currentPassword: PASSWORD, newPassword: NEXT } })).status, 403);
    for (const origin of [null, "https://attacker.example"]) {
      assert.equal((await h.request("/api/v1/account/password", { method: "POST", cookie: alice.cookie, origin,
        body: { currentPassword: PASSWORD, newPassword: NEXT } })).status, 403);
    }
    for (const [password, extra, code] of [[NEXT, { currentPassword: "wrong" }, "current_password_invalid"],
      [PASSWORD, {}, "password_unchanged"], ["short", {}, "invalid_newPassword"],
      ["a".repeat(129), {}, "invalid_newPassword"], [NEXT, { unknown: true }, "invalid_password_request"]]) {
      await h.resetLimits();
      assert.equal((await passwordChange(h, alice, password, extra)).body.error.code, code);
    }
    assert.deepEqual(await accountSnapshot(h, alice.id), before);
  } finally { await a.close(); }
});

test("passwords preserve spaces and Unicode and account-password attempts are rate limited", async () => {
  const a = await accountFixture(), { h, alice } = a;
  try {
    for (let i = 0; i < 5; i++) assert.equal((await passwordChange(h, alice, NEXT, { currentPassword: "wrong" })).status, 403);
    const now = Math.floor(Date.now() / 1000), minute = Math.floor(now / 60);
    const bucket = value => createHash("sha256").update(`account-password:${value}:${alice.id}`).digest("hex");
    const rows = (await h.db.prepare("SELECT bucket,attempts,expires_at FROM auth_rate_limits").all()).results;
    const attempts = rows.filter(row => row.bucket === bucket(Math.floor((row.expires_at - 120) / 60)));
    assert.equal(attempts.reduce((sum, row) => sum + row.attempts, 0), 5, "Every real failure must consume an attempt, even across a minute boundary");
    // Seed the exact threshold for both adjacent buckets; CPU/load cannot make the assertion depend on wall-clock rollover.
    await h.db.batch([minute, minute + 1].map(value => h.db.prepare(`INSERT INTO auth_rate_limits(bucket,attempts,expires_at) VALUES (?,5,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=5`).bind(bucket(value), now + 180)));
    assert.equal((await passwordChange(h, alice, NEXT)).status, 429);
    await h.resetLimits();
    const password = "  中文密码与空格-保留原文-35824  ";
    ok(await passwordChange(h, alice, password));
    assert.equal((await login(h, alice, password.trim())).status, 401);
    ok(await login(h, alice, password));
  } finally { await a.close(); }
});
