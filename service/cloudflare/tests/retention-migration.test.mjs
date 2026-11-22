import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { seedLegacyCloudflare } from "./legacy-mailbox-fixture.mjs";

test("0007 to retention is an additive, repeatable upgrade preserving ciphertext, lifecycle, provider state and replay guards", async () => {
  const f = await providerFixture();
  let h;
  try {
    h = await createHarness(f.bindings, false, "0007_admin_providers.sql");
    const user = await h.register("retention-upgrade"), box = await seedLegacyCloudflare(h, f, user.id);
    await newKey(h, user.cookie);
    await h.db.prepare("UPDATE mailboxes SET disabled_at=123,note='保留期限前备注',favorite=1 WHERE id=?").bind(box.id).run();
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,123)").bind(user.id).run();
    await h.db.prepare("INSERT INTO provider_overrides VALUES ('self','{}',1,'stored','synthetic-preserved-cipher','preserved-change',123)").run();
    await h.db.prepare("INSERT INTO provider_health VALUES ('self',1,'preserved-hash',123,'error','provider_timeout','preserved-probe')").run();
    await h.db.prepare("INSERT INTO admin_audit VALUES (?,?,'self','configure',1,'replace',NULL,123)").bind(crypto.randomUUID(), user.id).run();
    await h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,observed_at,trashed_at,purged_at)
      VALUES (?,?,?,'1','retained-tombstone','','','','','','[]',120,121,122)`).bind(crypto.randomUUID(), user.id, box.id).run();
    await h.db.prepare(`INSERT INTO outgoing_messages(id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,from_address,to_address,subject,text_body,threading,state,created_at,updated_at)
      VALUES (?,?,?,'retained-key','retained-hash','self','binding',?,'recipient@example.test','保留发送','未知结果','none','unknown',123,124)`)
      .bind(crypto.randomUUID(), user.id, box.id, box.address).run();
    const tables = ["users", "sessions", "api_keys", "mailboxes", "mailbox_creations", "messages", "outgoing_messages",
      "platform_admins", "provider_overrides", "provider_health", "admin_audit"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const after = (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
      assert.equal(after.length, before[table].length, table);
      for (const [index, old] of before[table].entries()) {
        for (const field of Object.keys(old)) assert.deepEqual(after[index][field], old[field], `${table}.${field}`);
      }
    }
    for (const [table, fields] of Object.entries({ mailboxes: ["expires_at", "expired_at"],
      mailbox_creations: ["expires_at", "policy_revision"], outgoing_messages: ["content_purged_at"] })) {
      for (const row of (await h.db.prepare(`SELECT * FROM ${table}`).all()).results) for (const field of fields) assert.equal(row[field], null);
    }
    const state = await h.request("/api/v1/admin/retention", { cookie: user.cookie });
    assert.equal(state.status, 200); assert.equal(state.body.revision, 0); assert.equal(state.body.policy.enabled, false);
    for (const field of ["mailboxDays", "cacheDays", "trashDays", "outgoingDays", "auditDays"]) assert.equal(state.body.policy[field], 0);
    assert.equal(state.body.lastRun, null); assert.equal(f.calls.length, 0);
    console.log(`M3e->M3f preservation evidence: ${h.directory}`);
  } finally { await h?.close(); await f.close(); }
});
