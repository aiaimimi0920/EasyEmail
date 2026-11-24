import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, INVITE, newKey, PASSWORD, seedMailbox } from "./runtime-harness.mjs";
import { CLIENT_ID, ISSUER, naccountFixture } from "./naccount-auth-fixture.mjs";

let f;

before(async () => {
  f = await naccountFixture();
});

beforeEach(async () => {
  f.setMode("normal");
  await f.h.resetLimits();
});

after(async () => {
  if (f) await f.close();
});

async function insertLocalUser(db, username, password = PASSWORD) {
  const id = crypto.randomUUID();
  const salt = "0123456789abcdef0123456789abcdef";
  const derived = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 33554432 }).toString("hex");
  const hash = `scrypt$16384$8$5$${salt}$${derived}`;
  await db.prepare("INSERT INTO users(id, username, password_hash, status, created_at) VALUES (?, ?, ?, 'active', unixepoch())")
    .bind(id, username, hash).run();
  return id;
}

test("auth config reports built-in NAccount settings on mail.aiaimimi.com and local mode on unconfigured origins", async () => {
  const localHarness = await createHarness();
  try {
    const localCfg = await localHarness.request("/api/v1/auth/config");
    assert.equal(localCfg.status, 200);
    assert.deepEqual(localCfg.body, { auth: { mode: "local" } });
  } finally {
    await localHarness.close();
  }

  const prodHarness = await createHarness({ APP_ORIGIN: "https://mail.aiaimimi.com" });
  try {
    const prodCfg = await prodHarness.request("/api/v1/auth/config", { origin: "https://mail.aiaimimi.com" });
    assert.equal(prodCfg.status, 200);
    assert.deepEqual(prodCfg.body, {
      auth: {
        mode: "naccount",
        issuer: ISSUER,
        clientId: CLIENT_ID,
        redirectUri: "https://mail.aiaimimi.com/auth/callback",
        accountUrl: `${ISSUER}/account`,
        logoutUrl: `${ISSUER}/oauth2/v1/logout`,
        postLogoutRedirectUri: "https://mail.aiaimimi.com",
      },
    });
  } finally {
    await prodHarness.close();
  }
});

test("first NAccount login links existing unlinked vmjcv666 account, preserves mailbox & API key, and grants super_admin", async () => {
  const legacyId = await insertLocalUser(f.h.db, "vmjcv666");
  const mailboxId = await seedMailbox(f.h, legacyId, "vmjcv666@aiaimimi.com");
  const issued = f.issueCode({
    sub: "e7b183d6-a81f-485a-9c89-32750b1346d0",
    email: "vmjcv666@gmail.com",
    roles: ["super_admin"],
  });
  const login = await f.complete(issued);
  assert.equal(login.status, 200, login.text);
  assert.deepEqual(login.body.user, { id: legacyId, username: "vmjcv666" });
  const cookieHeader = login.headers.get("set-cookie") ?? "";
  for (const attr of ["__Host-ee_session=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) {
    assert.ok(cookieHeader.includes(attr), attr);
  }

  const me = await f.h.request("/api/v1/me", { cookie: login.cookie });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user, { id: legacyId, username: "vmjcv666", isAdmin: true });

  const key = await newKey(f.h, login.cookie);
  const boxes = await f.h.request("/api/v1/mailboxes", { token: key.token, origin: null });
  assert.equal(boxes.status, 200);
  assert.deepEqual(boxes.body.items.map((item) => item.id), [mailboxId]);

  const row = await f.h.db.prepare("SELECT password_hash FROM users WHERE id = ?").bind(legacyId).first();
  assert.equal(row.password_hash, "naccount$managed");
});

test("ordinary NAccount user auto-provisions non-admin user and handles username collision without hijacking bound accounts", async () => {
  const first = f.issueCode({
    sub: "308008d6-2fad-4585-950a-b9861530cc22",
    email: "vmjcv111@gmail.com",
    roles: [],
  });
  const firstLogin = await f.complete(first);
  assert.equal(firstLogin.status, 200, firstLogin.text);
  assert.equal(firstLogin.body.user.username, "vmjcv111");
  const firstMe = await f.h.request("/api/v1/me", { cookie: firstLogin.cookie });
  assert.equal(firstMe.body.user.isAdmin, false);

  const colliding = f.issueCode({
    sub: "99999999-2fad-4585-950a-b9861530cc99",
    email: "vmjcv111@example.org",
    roles: [],
  });
  const secondLogin = await f.complete(colliding);
  assert.equal(secondLogin.status, 200, secondLogin.text);
  assert.notEqual(secondLogin.body.user.id, firstLogin.body.user.id);
  assert.match(secondLogin.body.user.username, /^vmjcv111-[a-f0-9]{6}$/);
});

test("bootstrap admin remains usable for SBA acceptance while local registration, user password login, and password change are blocked", async () => {
  const adminId = await insertLocalUser(f.h.db, "admin");
  await f.h.db.prepare("INSERT INTO platform_admins(user_id, created_at) VALUES (?, unixepoch())").bind(adminId).run();

  const imposter = f.issueCode({
    sub: "4629b8f3-1be5-43fc-af45-aea89a40e90b",
    email: "admin@aiaimimi.com",
    nickname: "admin",
    roles: [],
  });
  const imposterLogin = await f.complete(imposter);
  assert.equal(imposterLogin.status, 200, imposterLogin.text);
  assert.notEqual(imposterLogin.body.user.id, adminId);
  assert.notEqual(imposterLogin.body.user.username, "admin");

  const sbaAdmin = await f.h.request("/api/v1/auth/login", {
    method: "POST",
    body: { username: "admin", password: PASSWORD },
  });
  assert.equal(sbaAdmin.status, 200, sbaAdmin.text);
  assert.equal(sbaAdmin.body.user.id, adminId);

  const blockedReg = await f.h.request("/api/v1/auth/register", {
    method: "POST",
    body: { username: "local-new", password: PASSWORD, invite: INVITE },
  });
  assert.equal(blockedReg.status, 403);
  assert.equal(blockedReg.body.error.code, "naccount_login_required");

  const blockedLogin = await f.h.request("/api/v1/auth/login", {
    method: "POST",
    body: { username: "vmjcv666", password: PASSWORD },
  });
  assert.equal(blockedLogin.status, 403);
  assert.equal(blockedLogin.body.error.code, "naccount_login_required");

  const blockedPw = await f.h.request("/api/v1/account/password", {
    method: "POST",
    cookie: imposterLogin.cookie,
    body: { currentPassword: PASSWORD, newPassword: "Updated-password-1234567" },
  });
  assert.equal(blockedPw.status, 403);
  assert.equal(blockedPw.body.error.code, "naccount_account_managed");
});

test("self-service revoke-credentials revokes all sessions and API keys and records account audit", async () => {
  const issued = f.issueCode({
    sub: "19f2676c-3bb8-460e-a76a-9ddad8ff6c73",
    email: "revoke-check@aiaimimi.com",
    roles: [],
  });
  const login = await f.complete(issued);
  assert.equal(login.status, 200);
  const key = await newKey(f.h, login.cookie);
  const tokenHash = createHash("sha256").update(key.token).digest("hex");
  assert.ok(await f.h.db.prepare("SELECT id FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL").bind(tokenHash).first());

  const revoked = await f.h.request("/api/v1/account/revoke-credentials", {
    method: "POST",
    cookie: login.cookie,
    body: {},
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.ok((revoked.headers.get("set-cookie") ?? "").includes("Max-Age=0"));
  assert.equal((await f.h.request("/api/v1/me", { cookie: login.cookie })).status, 401);
  assert.equal((await f.h.request("/api/v1/me", { token: key.token, origin: null })).status, 401);

  const audit = await f.h.db.prepare("SELECT actor_id, user_id, action, revision FROM account_audit WHERE user_id = ?")
    .bind(login.body.user.id).first();
  assert.deepEqual(audit, {
    actor_id: login.body.user.id,
    user_id: login.body.user.id,
    action: "revoke-credentials",
    revision: 1,
  });
});
