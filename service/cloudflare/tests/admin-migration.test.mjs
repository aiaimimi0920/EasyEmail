import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { seedLegacyCloudflare } from "./legacy-mailbox-fixture.mjs";

test("0006 to admin expand preserves all existing records and defaults to no administrators or overrides", async () => {
  const f = await providerFixture();
  let h;
  try {
    h = await createHarness(f.bindings, false, "0006_lifecycle.sql");
    const user = await h.register("admin-upgrade-alice"), box = await seedLegacyCloudflare(h, f, user.id);
    const key = await newKey(h, user.cookie, { scopes: ["mailboxes:read", "messages:read"] });
    await h.db.prepare("UPDATE mailboxes SET disabled_at=123,note='保留备注',favorite=1 WHERE id=?").bind(box.id).run();
    const id = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,observed_at,trashed_at,purged_at)
      VALUES (?,?,?,'1','preserved-fingerprint','','','','','','[]',120,121,122)`).bind(id, user.id, box.id).run();
    await h.db.prepare(`INSERT INTO outgoing_messages(id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,from_address,to_address,subject,text_body,threading,state,created_at,updated_at)
      VALUES (?,?,?,'preserved-send-key','preserved-send-hash','self','binding',?,'recipient@example.test','保留发送','未知结果','none','unknown',123,124)`)
      .bind(crypto.randomUUID(), user.id, box.id, box.address).run();
    const tables = ["users", "sessions", "api_keys", "mailboxes", "mailbox_creations", "messages", "outgoing_messages"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const after = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
      assert.equal(after.length, before[table].length, table);
      for (const old of before[table]) {
        const row = after.find((item) => item.id === old.id);
        assert.ok(row, `${table}:${old.id}`);
        for (const field of Object.keys(old)) assert.deepEqual(row[field], old[field], `${table}.${field}`);
      }
    }
    const defaults = { mailboxes: ["expires_at", "expired_at"], mailbox_creations: ["expires_at", "policy_revision"], outgoing_messages: ["content_purged_at"] };
    for (const [table, fields] of Object.entries(defaults)) for (const row of (await h.db.prepare(`SELECT * FROM ${table}`).all()).results) {
      for (const field of fields) assert.equal(row[field], null, `${table}.${field}`);
    }
    for (const table of ["platform_admins", "provider_overrides", "provider_health", "admin_audit"]) {
      assert.equal((await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, 0);
    }
    assert.equal((await h.request("/api/v1/me", { cookie: user.cookie })).body.user.isAdmin, false);
    assert.equal((await h.request("/api/v1/providers", { token: key.token })).body.items.length, 2);
    assert.equal((await h.request("/api/v1/admin/overview", { cookie: user.cookie })).status, 403);
    assert.equal(f.calls.length, 0);
    console.log(`M3d->M3e preservation evidence: ${h.directory}`);
  } finally { await h?.close(); await f.close(); }
});
