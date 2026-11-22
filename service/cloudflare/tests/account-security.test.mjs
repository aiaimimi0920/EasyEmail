import assert from "node:assert/strict";
import { test } from "node:test";
import { accountFixture, accountAction, accountSnapshot, ok } from "./account-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("account management is live-admin session-only, origin guarded and strictly validated", async () => {
  const a = await accountFixture(), { h, admin, alice } = a;
  try {
    const key = await newKey(h, admin.cookie);
    for (const path of ["", "/audit", `/${alice.id}`]) {
      for (const credentials of [{ cookie: alice.cookie }, { token: key.token }]) {
        assert.equal((await h.request(`/api/v1/admin/users${path}`, credentials)).status, 403);
      }
    }
    for (const origin of [null, "https://attacker.example"]) {
      assert.equal((await h.request(`/api/v1/admin/users/${alice.id}/status`, { method: "POST", cookie: admin.cookie, origin,
        body: { status: "disabled", expectedRevision: 0, confirmUsername: alice.username } })).status, 403);
    }
    for (const extra of [{ unexpected: true }, { expectedRevision: -1 }, { expectedRevision: 0.1 },
      { expectedRevision: Number.MAX_SAFE_INTEGER }, { status: "deleted" }, { confirmUsername: "wrong" }, { confirmUsername: null }]) {
      assert.equal((await accountAction(h, admin, alice, "disable", 0, extra)).status, 400);
    }
    assert.equal((await accountAction(h, admin, admin, "disable")).body.error.code, "self_account_disable_denied");
    assert.equal((await accountAction(h, admin, { ...alice, id: crypto.randomUUID() }, "disable")).status, 404);
    assert.equal((await h.request(`/api/v1/admin/users/${alice.id}/status`, { cookie: admin.cookie })).status, 405);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM account_audit").first()).n, 0);
  } finally { await a.close(); }
});

test("user metadata and UUID pagination/search expose counts but never password hashes or credential secrets", async () => {
  const a = await accountFixture(), { h, admin, alice } = a;
  try {
    const key = await newKey(h, alice.cookie);
    const pages = [];
    let cursor = "";
    do {
      const page = ok(await h.request(`/api/v1/admin/users?limit=1${cursor ? `&cursor=${cursor}` : ""}`, { cookie: admin.cookie }));
      pages.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(pages.map((row) => row.id).sort(), [admin.id, alice.id].sort());
    const detail = await h.request(`/api/v1/admin/users/${alice.id}`, { cookie: admin.cookie });
    assert.equal(detail.body.user.activeKeys, 1); assert.equal(detail.body.user.activeSessions, 1);
    assert.equal(detail.body.user.isAdmin, false);
    for (const secret of [key.token, "password_hash", "token_hash", "scrypt$"]) assert.equal(detail.text.includes(secret), false);
    const matches = ok(await h.request("/api/v1/admin/users?q=ALICE&status=active", { cookie: admin.cookie }));
    assert.deepEqual(matches.items.map((row) => row.id), [alice.id]);
    for (const params of ["status=deleted", "q=" + "a".repeat(65), "other=true", "cursor=invalid", "limit=101"]) {
      assert.equal((await h.request(`/api/v1/admin/users?${params}`, { cookie: admin.cookie })).status, 400);
    }
    await h.db.prepare("DELETE FROM platform_admins WHERE user_id=?").bind(admin.id).run();
    assert.equal((await h.request("/api/v1/admin/users", { cookie: admin.cookie })).status, 403);
  } finally { await a.close(); }
});

test("same-state changes are no-ops; explicit revocation is audited and self-revocation clears the cookie", async () => {
  const a = await accountFixture(), { h, admin, alice } = a;
  try {
    await newKey(h, alice.cookie);
    const before = await accountSnapshot(h, alice.id);
    assert.equal(ok(await accountAction(h, admin, alice, "enable")).changed, false);
    assert.deepEqual(await accountSnapshot(h, alice.id), before);
    ok(await accountAction(h, admin, alice, "revoke-credentials"));
    assert.equal((await h.request("/api/v1/me", { cookie: alice.cookie })).status, 401);
    const audit = ok(await h.request(`/api/v1/admin/users/audit?userId=${alice.id}&limit=1`, { cookie: admin.cookie }));
    assert.equal(audit.items[0].action, "revoke-credentials");
    assert.deepEqual(Object.keys(audit.items[0]).sort(), ["id", "actorId", "userId", "action", "revision", "createdAt"].sort());
    const self = await accountAction(h, admin, admin, "revoke-credentials");
    assert.equal(ok(self).reauthenticate, true); assert.match(self.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await h.request("/api/v1/me", { cookie: admin.cookie })).status, 401);
  } finally { await a.close(); }
});
