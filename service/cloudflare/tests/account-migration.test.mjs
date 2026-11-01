import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey, seedMailbox } from "./runtime-harness.mjs";
import { accountAction, ok } from "./account-fixture.mjs";

test("0012 to 0013 is expand-only and migration runner repetition/restart preserve old identity, resources and credentials", async () => {
  const h = await createHarness({}, false, "0012_remote_mailbox_deletions.sql");
  try {
    const admin = await h.register("account-upgrade-admin"), alice = await h.register("account-upgrade-alice");
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    const key = await newKey(h, alice.cookie);
    await seedMailbox(h, alice.id, "upgrade-preserved@example.test");
    const tables = (await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all()).results;
    const before = {};
    for (const { name } of tables) before[name] = (await h.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='account_revisions'").first()).n, 0);
    await h.migrate(); await h.migrate(); await h.restart();
    for (const { name } of tables) assert.deepEqual((await h.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results, before[name], name);
    for (const name of ["account_revisions", "account_audit"]) assert.equal((await h.db.prepare(`SELECT COUNT(*) n FROM ${name}`).first()).n, 0);
    assert.equal((await h.request("/api/v1/me", { cookie: alice.cookie })).status, 200);
    assert.equal((await h.request("/api/v1/mailboxes", { token: key.token })).status, 200);
    ok(await accountAction(h, admin, alice, "disable"));
    await h.restart();
    assert.equal((await h.request("/api/v1/me", { cookie: alice.cookie })).status, 401);
    const row = await h.request(`/api/v1/admin/users/${alice.id}`, { cookie: admin.cookie });
    assert.equal(ok(row).user.revision, 1); assert.equal(row.body.user.status, "disabled");
  } finally { await h.close(); }
});
