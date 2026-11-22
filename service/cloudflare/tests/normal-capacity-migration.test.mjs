import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createHarness, seedMailbox } from "./runtime-harness.mjs";

test("36-to-37 only adds indexes, preserving every old row and object while using history-independent capacity, receipt and ACK plans", async () => {
  const h = await createHarness({}, false, "0036_normal_inbox_retention.sql", null, { r2Buckets: { INBOX: "normal-capacity-upgrade" } });
  try {
    const user = await h.register("normal-capacity-upgrade"), account = crypto.randomUUID(), batch = crypto.randomUUID();
    await seedMailbox(h, user.id, "legacy@example.test");
    await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES (?,?,'old@example.test','原邮箱','example','old-hash','old',0,1,1,1)`).bind(account, user.id).run();
    await h.db.prepare(`INSERT INTO normal_inbox_state(account_id,source_hash,epoch_id,uid_validity,after_uid,version,cache_generation)
      VALUES (?,'old-hash','old-epoch','42',7,5,2)`).bind(account).run();
    await h.db.prepare(`INSERT INTO normal_inbox_requests(id,account_id,request_key,account_revision,created_at,finished_at)
      VALUES ('old-request',?,'old-request-key-1234',1,1,2)`).bind(account).run();
    await h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,
      reset,complete,item_count,storage_bytes,manifest,status,created_at,committed_at,request_id,released_items)
      VALUES (?,?,1,'old-hash',4,'old-epoch','42',7,0,1,1,2097152,'{"items":[],"skipped":[]}','committed',1,2,'old-request',1)`).bind(batch, account).run();
    await h.db.prepare(`INSERT INTO retention_runs(id,run_key,request_hash,config_revision,policy_hash,trigger_kind,started_at,completed_at)
      VALUES ('old-run','old-run-key','old-run-hash',0,'old-policy','scheduled',1,2)`).run();
    const key = `normal-inbox/v1/${user.id}/${account}/${batch}/7.eml`, bytes = Uint8Array.from({ length: 2097152 }, (_, i) => i % 251);
    await (await h.bucket("INBOX")).put(key, bytes);
    await h.db.prepare(`INSERT INTO normal_inbox_object_deletions(object_key,batch_id,run_id,size_bytes,created_at)
      VALUES (?,?,'old-run',2097152,2)`).bind(key, batch).run();
    const tables = (await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()).results
      .filter(r => !r.name.startsWith("sqlite_") && !r.name.startsWith("_cf_"));
    const before = {}; for (const { name } of tables) before[name] = (await h.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
    await h.migrate("0037_normal_sync_capacity.sql"); await h.migrate("0037_normal_sync_capacity.sql"); await h.restart();
    const afterTables = (await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()).results
      .filter(r => !r.name.startsWith("sqlite_") && !r.name.startsWith("_cf_"));
    assert.deepEqual(afterTables, tables);
    for (const { name } of tables) assert.deepEqual((await h.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results, before[name], name);
    assert.deepEqual(new Uint8Array(await (await (await h.bucket("INBOX")).get(key)).arrayBuffer()), bytes);
    const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/normal-inbox-capacity.ts", import.meta.url))], bundle: true, write: false, format: "esm" });
    const { NORMAL_INBOX_CAPACITY } = await import(`data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`);
    const capacityPlan = (await h.db.prepare(`EXPLAIN QUERY PLAN SELECT ${NORMAL_INBOX_CAPACITY}`).bind(account, 1, 1).all()).results;
    assert.match(JSON.stringify(capacityPlan), /USING (?:COVERING )?INDEX normal_inbox_live_capacity/);
    const recentPlan = (await h.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM normal_inbox_requests WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 20").bind(account).all()).results;
    assert.match(JSON.stringify(recentPlan), /normal_inbox_requests_recent/); assert.doesNotMatch(JSON.stringify(recentPlan), /TEMP B-TREE/);
    const ackPlan = (await h.db.prepare("EXPLAIN QUERY PLAN SELECT SUM(size_bytes) FROM normal_inbox_object_deletions WHERE batch_id=? AND cleaned_at IS NOT NULL").bind(batch).all()).results;
    assert.match(JSON.stringify(ackPlan), /normal_inbox_object_ack_batch/);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await h.close(); }
});
