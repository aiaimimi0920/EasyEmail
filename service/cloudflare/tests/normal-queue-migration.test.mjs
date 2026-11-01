import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, seedMailbox } from "./runtime-harness.mjs";

test("34-to-35 additive normal queue preserves old tables, drafts, assets and no-repeat guards through restart", async () => {
  const h = await createHarness({}, false, "0034_normal_attachments.sql");
  try {
    const user = await h.register("normal-queue-upgrade"), mailbox = await seedMailbox(h, user.id, "old@example.test"), account = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES (?,?,'ordinary@example.test','old','example','hash','old',0,1,1,1)`).bind(account, user.id).run();
    await h.db.prepare(`INSERT INTO send_jobs(id,user_id,mailbox_id,request_key,request_hash,outgoing_key,payload_json,due_at,deadline_at,next_attempt_at,state,created_at,updated_at)
      VALUES (?,?,?,'old-intent-key-12345','old-intent-hash','old-outgoing-key','{"subject":"old"}',1,9999999999,1,'queued',1,1)`).bind(crypto.randomUUID(), user.id, mailbox).run();
    await h.db.prepare(`INSERT INTO drafts(user_id,id,revision,subject,text_body,content_hash,normal_account_id,normal_account_revision,normal_attachments_json,created_at,updated_at)
      VALUES (?,?,1,'old','text','old-hash',?,1,'[{"id":"old","version":"old"}]',1,1)`).bind(user.id, crypto.randomUUID(), account).run();
    const tables = ["users", "sessions", "normal_accounts", "normal_smtp_configs", "normal_inbox_messages", "outbox_assets", "drafts", "normal_outgoing_messages", "outgoing_messages", "send_jobs", "send_job_operations", "send_recipient_charges"];
    const before = {}; for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate("0037_normal_sync_capacity.sql"); await h.migrate("0037_normal_sync_capacity.sql"); await h.restart();
    for (const table of tables) assert.deepEqual((await h.db.prepare(`SELECT * FROM ${table}`).all()).results, before[table], table);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_send_jobs").first("n"), 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM send_job_usage").first("n"), 1);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    const sql = `INSERT INTO normal_send_jobs(id,user_id,account_id,account_revision,smtp_revision,request_key,request_hash,outgoing_key,due_at,deadline_at,next_attempt_at,state,created_at,updated_at) VALUES (?,?,?,1,1,?,'hash',?,1,2,1,'queued',1,1)`;
    const id = crypto.randomUUID(); await h.db.prepare(sql).bind(id, user.id, account, crypto.randomUUID(), crypto.randomUUID()).run();
    const bob = await h.register("normal-queue-foreign"); await assert.rejects(h.db.prepare(sql).bind(crypto.randomUUID(), bob.id, account, crypto.randomUUID(), crypto.randomUUID()).run(), /FOREIGN KEY/);
    await assert.rejects(h.db.prepare("UPDATE normal_send_jobs SET attempts=6 WHERE id=?").bind(id).run(), /CHECK/);
    await assert.rejects(h.db.prepare("UPDATE normal_send_jobs SET attachments_json='{}' WHERE id=?").bind(id).run(), /CHECK/);
  } finally { await h.close(); }
});
