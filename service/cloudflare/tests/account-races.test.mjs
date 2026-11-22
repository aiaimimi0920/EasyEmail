import assert from "node:assert/strict";
import { test } from "node:test";
import { accountFixture, accountAction, accountSnapshot, passwordChange, login, ok } from "./account-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";

const entry = new URL("./account-gated-worker.ts", import.meta.url);
const NEXT = "Racing-new-password-3572548";

test("password changes invalidate a real login snapshot before it can insert or prune sessions", async () => {
  const gates = await selectGates();
  let a, gate, pending;
  try {
    a = await accountFixture(gates.bindings, entry);
    const { h, alice } = a;
    gate = gates.hold("login-snapshot", "login");
    pending = login(h, alice, undefined, { headers: gate.headers });
    await gate.entered();
    ok(await passwordChange(h, alice, NEXT));
    const before = await accountSnapshot(h, alice.id);
    gate.release();
    const result = await pending;
    assert.equal(result.status, 401, result.text); assert.equal(result.cookie, undefined);
    assert.deepEqual(await accountSnapshot(h, alice.id), before);
    ok(await login(h, alice, NEXT));
  } finally { gate?.release(); await pending?.catch(() => {}); await a?.close(); await gates.close(); }
});

test("credential revocation fences Key issuance after authentication produced an old session identity", async () => {
  const gates = await selectGates();
  let a, gate, pending;
  try {
    a = await accountFixture(gates.bindings, entry);
    const { h, admin, alice } = a;
    gate = gates.hold("key-auth-snapshot", "session");
    pending = h.request("/api/v1/api-keys", { cookie: alice.cookie, method: "POST", headers: gate.headers,
      body: { name: "must-not-be-issued", scopes: ["mailboxes:read"] } });
    await gate.entered();
    ok(await accountAction(h, admin, alice, "revoke-credentials"));
    gate.release();
    assert.equal((await pending).status, 401);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM api_keys WHERE user_id=?").bind(alice.id).first()).n, 0);
  } finally { gate?.release(); await pending?.catch(() => {}); await a?.close(); await gates.close(); }
});

test("disabling an account invalidates a login that already read its active password snapshot", async () => {
  const gates = await selectGates();
  let a, gate, pending;
  try {
    a = await accountFixture(gates.bindings, entry);
    const { h, admin, alice } = a;
    gate = gates.hold("disabled-login", "login");
    pending = login(h, alice, undefined, { headers: gate.headers });
    await gate.entered();
    ok(await accountAction(h, admin, alice, "disable"));
    const before = await accountSnapshot(h, alice.id);
    gate.release();
    assert.equal((await pending).status, 401);
    assert.deepEqual(await accountSnapshot(h, alice.id), before);
  } finally { gate?.release(); await pending?.catch(() => {}); await a?.close(); await gates.close(); }
});

test("removing administrator membership before commit fences a previously authorized account write", async () => {
  const gates = await selectGates();
  let a, gate, pending;
  try {
    a = await accountFixture(gates.bindings, entry);
    const { h, admin, alice } = a;
    gate = gates.hold("removed-admin", "account");
    pending = h.request(`/api/v1/admin/users/${alice.id}/status`, { cookie: admin.cookie, method: "POST", headers: gate.headers,
      body: { status: "disabled", expectedRevision: 0, confirmUsername: alice.username } });
    await gate.entered();
    await h.db.prepare("DELETE FROM platform_admins WHERE user_id=?").bind(admin.id).run();
    const before = await accountSnapshot(h, alice.id);
    gate.release();
    assert.equal((await pending).status, 403);
    assert.deepEqual(await accountSnapshot(h, alice.id), before);
  } finally { gate?.release(); await pending?.catch(() => {}); await a?.close(); await gates.close(); }
});

test("two administrators attempting mutual disable cannot both win after their account snapshots", async () => {
  const gates = await selectGates();
  let a, first, second, p1, p2;
  try {
    a = await accountFixture(gates.bindings, entry);
    const { h, admin, alice } = a;
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(alice.id).run();
    first = gates.hold("first-admin", "account"); second = gates.hold("second-admin", "account");
    const disable = (actor, target, gate) => h.request(`/api/v1/admin/users/${target.id}/status`, {
      cookie: actor.cookie, method: "POST", headers: gate.headers,
      body: { status: "disabled", expectedRevision: 0, confirmUsername: target.username },
    });
    p1 = disable(admin, alice, first); p2 = disable(alice, admin, second);
    await Promise.all([first.entered(), second.entered()]);
    first.release(); ok(await p1); second.release();
    assert.equal((await p2).status, 401);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM users WHERE status='active'").first()).n, 1);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM account_audit").first()).n, 1);
  } finally {
    first?.release(); second?.release(); await Promise.allSettled([p1, p2]); await a?.close(); await gates.close();
  }
});

test("revision CAS has one winner; audit and final revision failures roll back status, password and revocation", async () => {
  const a = await accountFixture(), { h, admin, alice } = a;
  try {
    const results = await Promise.all([accountAction(h, admin, alice, "revoke-credentials"), accountAction(h, admin, alice, "revoke-credentials")]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    alice.cookie = (await login(h, alice)).cookie;
    for (const [table, action] of [["account_audit", "disable"], ["account_revisions", "disable"], ["account_revisions", "password"]]) {
      const before = await accountSnapshot(h, alice.id);
      const operation = table === "account_revisions" ? "UPDATE" : "INSERT";
      await h.db.prepare(`CREATE TRIGGER fail_account_write BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`).run();
      try {
        const result = action === "password" ? await passwordChange(h, alice, NEXT) : await accountAction(h, admin, alice, action, 1);
        assert.equal(result.status, 500, result.text);
      } finally { await h.db.prepare("DROP TRIGGER fail_account_write").run(); }
      assert.deepEqual(await accountSnapshot(h, alice.id), before);
    }
  } finally { await a.close(); }
});
