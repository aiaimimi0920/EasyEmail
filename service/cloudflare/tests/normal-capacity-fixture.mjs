import { createHash } from "node:crypto";

export async function seedNormalSyncHistory(t, batchId, count = 1005) {
  await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO normal_inbox_requests(id,account_id,request_key,account_revision,created_at,finished_at)
    SELECT 'history-request-'||i,?,'historical-sync-key-'||i,1,unixepoch()-1000,unixepoch()-999 FROM n`).bind(count, t.id).run();
  await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,
      reset,complete,item_count,storage_bytes,manifest,request_id,status,created_at,committed_at,released_items,released_bytes)
    SELECT 'history-batch-'||i,b.account_id,b.account_revision,b.source_hash,b.from_version,b.epoch_id,b.uid_validity,b.after_uid,
      b.reset,b.complete,b.item_count,b.storage_bytes,'{"items":[],"skipped":[]}','history-request-'||i,'committed',
      unixepoch()-1000,unixepoch()-999,b.item_count,b.storage_bytes FROM n JOIN normal_inbox_batches b WHERE b.id=?`).bind(count, batchId).run();
}

export async function exhaustAdmission(h, category, subject, limit) {
  const minute = Math.floor(Date.now() / 60000);
  // Seed adjacent buckets too, so a test crossing a wall-clock minute cannot become flaky.
  for (let offset = 0; offset <= 1; offset++) {
    const bucket = createHash("sha256").update(`${category}:${minute + offset}:${subject}`).digest("hex");
    await h.db.prepare(`INSERT INTO auth_rate_limits(bucket,attempts,expires_at) VALUES(?,?,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=excluded.attempts`).bind(bucket, limit, (minute + offset + 2) * 60).run();
  }
}

export const syncRows = h => h.db.prepare("SELECT * FROM normal_inbox_requests ORDER BY id").all().then(r => r.results);

export async function syncBudgetRows(t) {
  const buckets = new Set(), minute = Math.floor(Date.now() / 60000);
  for (const [category, subject] of [["normal-inbox-request", t.alice.id], ["normal-inbox-request-global", "platform"],
    ["normal-inbox-sync", t.alice.id], ["normal-inbox-sync-global", "platform"]]) {
    for (let offset = -1; offset <= 1; offset++) buckets.add(createHash("sha256").update(`${category}:${minute + offset}:${subject}`).digest("hex"));
  }
  return (await t.h.db.prepare("SELECT * FROM auth_rate_limits ORDER BY bucket").all()).results.filter(row => buckets.has(row.bucket));
}
