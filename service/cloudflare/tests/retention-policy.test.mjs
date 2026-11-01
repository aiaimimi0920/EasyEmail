import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, ok } from "./admin-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { retentionFixture } from "./retention-fixture.mjs";

test("retention control plane is administrator-only, default-off, revisioned, origin guarded and durable", async () => {
  const a = await adminFixture(), { h, admin, alice } = a;
  try {
    assert.equal((await h.request("/api/v1/admin/retention", { cookie: alice.cookie })).status, 403);
    const key = await newKey(h, admin.cookie);
    assert.equal((await h.request("/api/v1/admin/retention", { token: key.token })).status, 403);
    const initial = ok(await h.request("/api/v1/admin/retention", { cookie: admin.cookie }));
    assert.equal(initial.revision, 0); assert.equal(initial.policy.enabled, false);
    for (const field of ["mailboxDays", "cacheDays", "trashDays", "outgoingDays", "auditDays"]) assert.equal(initial.policy[field], 0);
    const body = { expectedRevision: 0, policy: { ...initial.policy, enabled: true, mailboxDays: 1, cacheDays: 30, trashDays: 7 }, confirm: "APPLY RETENTION" };
    const save = (extra = {}) => h.request("/api/v1/admin/retention", { cookie: admin.cookie, method: "PUT", body, ...extra });
    assert.equal((await save({ origin: null })).status, 403); ok(await save());
    assert.equal((await save()).status, 409);
    await h.restart();
    const current = ok(await h.request("/api/v1/admin/retention", { cookie: admin.cookie }));
    assert.equal(current.revision, 1); assert.deepEqual(current.policy, body.policy);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM retention_policy_changes").first()).n, 1);
    assert.equal(a.f.calls.length, 0);
  } finally { await a.close(); }
});

test("retention config rejects incomplete, injected, unconfirmed and out-of-range values without mutation", async () => {
  const a = await retentionFixture(), { h, admin } = a;
  try {
    const state = await a.retention();
    const valid = { expectedRevision: 0, policy: state.policy, confirm: "APPLY RETENTION" };
    for (const extra of [{ confirm: "yes" }, { expectedRevision: -1 }, { expectedRevision: 0.5 }, { unknown: true },
      { policy: { ...state.policy, enabled: "true" } }, { policy: { ...state.policy, cacheDays: 3651 } },
      { policy: { ...state.policy, trashDays: -1 } }, { policy: { ...state.policy, outgoingDays: 1.5 } },
      { policy: { ...state.policy, favoriteExempt: true } }, { policy: { enabled: true, cacheDays: 30 } }]) {
      assert.equal((await h.request("/api/v1/admin/retention", { cookie: admin.cookie, method: "PUT", body: { ...valid, ...extra } })).status, 400);
    }
    assert.equal((await a.retention()).revision, 0);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM retention_policy_changes").first()).n, 0);
    assert.equal((await h.request("/api/v1/admin/retention/run", { cookie: admin.cookie, method: "POST", body: { expectedRevision: 0, confirm: "RUN RETENTION" } })).status, 400);
    assert.equal((await h.request("/api/v1/admin/retention/run", { cookie: admin.cookie, method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 0, confirm: "yes" } })).status, 400);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM retention_runs").first()).n, 0);
  } finally { await a.close(); }
});

test("policy CAS and policy audit form one transaction; old snapshots cannot maintain data or reconfigure", async () => {
  const a = await retentionFixture(), { h, admin } = a;
  try {
    const state = await a.retention(), body = { expectedRevision: 0, policy: { ...state.policy, enabled: true, cacheDays: 1 }, confirm: "APPLY RETENTION" };
    const save = () => h.request("/api/v1/admin/retention", { cookie: admin.cookie, method: "PUT", body });
    const results = await Promise.all([save(), save()]);
    assert.deepEqual(results.map((row) => row.status).sort(), [200, 409]);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM retention_policy_changes").first()).n, 1);
    assert.equal((await a.run(crypto.randomUUID(), 0)).body.error.code, "retention_policy_changed");
    await h.db.prepare("CREATE TRIGGER fail_retention_audit BEFORE INSERT ON retention_policy_changes BEGIN SELECT RAISE(ABORT, 'synthetic policy audit failure'); END").run();
    try { assert.equal((await a.policy({ cacheDays: 2 })).status, 500); }
    finally { await h.db.prepare("DROP TRIGGER fail_retention_audit").run(); }
    assert.equal((await a.retention()).revision, 1); assert.equal((await a.retention()).policy.cacheDays, 1);
  } finally { await a.close(); }
});
