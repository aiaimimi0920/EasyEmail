import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const historyKey = i => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
export async function seedAgentRequestHistory(t, count = 10005) {
  await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO agent_inbox_requests(id,user_id,account_id,request_key,account_revision,state,error_code,created_at,finished_at)
    SELECT 'history-request-'||i,?,?,printf('00000000-0000-4000-8000-%012d',i),1,'failed','synthetic_history_failure',1,2 FROM n`)
    .bind(count, t.alice.id, t.id).run();
}
export async function seedAgentEmptyHistory(t, original, count = 1005, state = "committed") {
  assert.ok(["staged", "committed", "retiring", "retired"].includes(state));
  await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO agent_inbox_requests(id,user_id,account_id,request_key,account_revision,state,result_json,created_at,finished_at)
    SELECT 'empty-request-'||i,?,?,printf('10000000-0000-4000-8000-%012d',i),1,'committed',
      json_set(?, '$.batchId','empty-batch-'||i,'$.stored',0),1,2 FROM n`)
    .bind(count, t.alice.id, t.id, JSON.stringify(original.result)).run();
  await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO agent_inbox_batches(id,user_id,account_id,request_id,source_hash,from_version,epoch_id,uid_validity,
      after_uid,state,item_count,storage_bytes,manifest,created_at,committed_at)
    SELECT 'empty-batch-'||i,b.user_id,b.account_id,'empty-request-'||i,b.source_hash,b.from_version,b.epoch_id,b.uid_validity,
      b.after_uid,?,0,0,'{"items":[],"skipped":[]}',1,2 FROM n JOIN agent_inbox_batches b WHERE b.id=?`)
    .bind(count, state, original.result.batchId).run();
}
export async function agentHistoryDigest(t, table, excludeId = "") {
  assert.ok(["agent_inbox_requests", "agent_inbox_batches"].includes(table));
  const rows = (await t.h.db.prepare(`SELECT * FROM ${table} WHERE (?='' OR id<>?) ORDER BY id`).bind(excludeId, excludeId).all()).results;
  return { count: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}
export async function seedAgentContentHistory(t, original, count) {
  await seedAgentEmptyHistory(t, original, count);
  const batch = await t.h.db.prepare("SELECT * FROM agent_inbox_batches WHERE id=?").bind(original.result.batchId).first();
  await t.h.db.prepare(`UPDATE agent_inbox_batches SET item_count=?,storage_bytes=?,manifest=replace(?,? ,id)
    WHERE id LIKE 'empty-batch-%'`).bind(batch.item_count, batch.storage_bytes, batch.manifest, batch.id).run();
  await t.h.db.prepare(`UPDATE agent_inbox_requests SET result_json=json_set(result_json,'$.stored',?)
    WHERE id LIKE 'empty-request-%'`).bind(batch.item_count).run();
}
export async function exhaustAgentAdmission(t, global = false) {
  const kind = global ? "agent-inbox-request-global" : "agent-inbox-request", id = global ? "platform" : t.alice.id;
  const minute = Math.floor(Date.now() / 60000);
  for (const start of [minute, minute + 1, minute + 2]) {
    const key = createHash("sha256").update(`${kind}:${start}:${id}`).digest("hex");
    await t.h.db.prepare(`INSERT INTO auth_rate_limits(bucket,attempts,expires_at) VALUES (?,?,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=excluded.attempts`).bind(key, global ? 60 : 10, (start + 2) * 60).run();
  }
}
