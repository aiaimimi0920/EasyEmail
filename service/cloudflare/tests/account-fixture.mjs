import assert from "node:assert/strict";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";

export async function accountFixture(overrides = {}, entry = null) {
  const h = await createHarness(overrides, false, null, entry);
  try {
    const admin = await h.register("account-operator");
    const alice = await h.register("account-alice");
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    return { h, admin, alice, close: () => h.close() };
  } catch (error) { await h.close(); throw error; }
}

export function accountAction(h, admin, target, action, revision = 0, extra = {}) {
  return h.request(`/api/v1/admin/users/${target.id}/${action === "revoke-credentials" ? action : "status"}`, {
    cookie: admin.cookie, method: "POST", body: {
      expectedRevision: revision, confirmUsername: target.username,
      ...(action === "revoke-credentials" ? {} : { status: action === "disable" ? "disabled" : "active" }),
      ...extra,
    },
  });
}

export function passwordChange(h, user, password, extra = {}) {
  return h.request("/api/v1/account/password", {
    cookie: user.cookie, method: "POST", body: { currentPassword: PASSWORD, newPassword: password, ...extra },
  });
}

export function login(h, user, password = PASSWORD, extra = {}) {
  return h.request("/api/v1/auth/login", { method: "POST", body: { username: user.username, password }, ...extra });
}

export async function accountSnapshot(h, userId) {
  const data = {};
  for (const table of ["users", "sessions", "api_keys", "account_revisions", "account_audit"]) {
    const column = table === "users" ? "id" : "user_id";
    data[table] = (await h.db.prepare(`SELECT * FROM ${table} WHERE ${column}=? ORDER BY rowid`).bind(userId).all()).results;
  }
  return data;
}

export function ok(response, status = 200) {
  assert.equal(response.status, status, response.text);
  return response.body;
}
