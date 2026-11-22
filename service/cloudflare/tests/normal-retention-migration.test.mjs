import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, seedMailbox } from "./runtime-harness.mjs";

test("35-to-36 preserves old receive identity, objects, guards and queue metadata with dormant additive cleanup defaults", async () => {
  const h = await createHarness({}, false, "0035_normal_send_jobs.sql", null, { r2Buckets: { INBOX: "normal-retention-upgrade" } });
  try {
    const user = await h.register("normal-retention-upgrade"), account = crypto.randomUUID(), batch = crypto.randomUUID(), message = crypto.randomUUID();
    await seedMailbox(h, user.id, "old@example.test");
    await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES (?,?,'old@example.test','原邮箱','example','old-hash','old',0,1,1,1)`).bind(account, user.id).run();
    await h.db.prepare(`INSERT INTO normal_inbox_state(account_id,source_hash,epoch_id,uid_validity,after_uid,version) VALUES (?,'old-hash','old-epoch','42',7,5)`).bind(account).run();
    const key = `normal-inbox/v1/${user.id}/${account}/${batch}/7.eml`, bucket = await h.bucket("INBOX"), bytes = Uint8Array.from({ length: 2097152 }, (_, i) => i % 251);
    await bucket.put(key, bytes);
    await h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at,committed_at)
      VALUES (?, ?,1,'old-hash',4,'old-epoch','42',7,0,1,1,2097153,'{"items":[],"skipped":[]}','committed',1,2)`).bind(batch, account).run();
    await h.db.prepare(`INSERT INTO normal_inbox_messages(id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,observed_at)
      VALUES (?,?,?,'old-epoch','42',7,?,'old-content','old-raw-sha','old-content-sha',2097152,1,1,'[]',1)`).bind(message, account, batch, key).run();
    await h.db.prepare(`INSERT INTO normal_send_jobs(id,user_id,account_id,account_revision,smtp_revision,request_key,request_hash,outgoing_key,payload_json,due_at,deadline_at,next_attempt_at,state,created_at,updated_at)
      VALUES (?,?,?,1,1,'old-key','old-hash','queue:old','{"reply":"old"}',1,2,1,'cancelled',1,1)`).bind(crypto.randomUUID(), user.id, account).run();
    await h.db.prepare(`INSERT INTO retention_runs(id,run_key,request_hash,config_revision,policy_hash,trigger_kind,started_at,completed_at)
      VALUES ('old-run','old-run-key','old-run-hash',0,'old-policy','scheduled',1,2)`).run();
    const tables = ["users", "sessions", "mailboxes", "normal_accounts", "normal_inbox_state", "normal_inbox_batches", "normal_inbox_messages", "normal_send_jobs", "retention_runs", "retention_policy"];
    const before = {}; for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const after = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results; assert.equal(after.length, before[table].length);
      for (const [i, row] of before[table].entries()) for (const [field, value] of Object.entries(row)) assert.deepEqual(after[i][field], value, `${table}.${field}`);
    }
    assert.equal(await h.db.prepare("SELECT cache_generation FROM normal_inbox_state").first("cache_generation"), 0);
    const extra = await h.db.prepare("SELECT released_items,released_bytes,retired_at,retired_run_id FROM normal_inbox_batches").first();
    assert.deepEqual(extra, { released_items: 0, released_bytes: 0, retired_at: null, retired_run_id: null });
    assert.equal(await h.db.prepare("SELECT purged_at FROM normal_inbox_messages").first("purged_at"), null);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_object_deletions").first("n"), 0);
    assert.deepEqual(new Uint8Array(await (await (await h.bucket("INBOX")).get(key)).arrayBuffer()), bytes);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    await assert.rejects(h.db.prepare("UPDATE normal_inbox_batches SET released_items=2 WHERE id=?").bind(batch).run(), /CHECK/);
    await assert.rejects(h.db.prepare("UPDATE normal_inbox_batches SET released_bytes=2097154 WHERE id=?").bind(batch).run(), /CHECK/);
  } finally { await h.close(); }
});
