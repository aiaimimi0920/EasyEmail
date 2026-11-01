import type { Env } from "./contracts";
import { RETENTION_BATCH_LIMIT, type RetentionPolicy } from "./retention-policy";
import { normalRetentionSelection, normalStagingSelection, normalReceiveLeaseTable, NORMAL_STAGING_GRACE } from "./normal-retention-selection";

export async function normalRetentionStatements(env: Env, policy: RetentionPolicy, now: number, runId: string) {
  const leaseTable = await normalReceiveLeaseTable(env), selection = normalRetentionSelection(policy, now, leaseTable);
  const guard = "EXISTS (SELECT 1 FROM retention_runs WHERE id=? AND completed_at IS NULL)";
  const purged = "SELECT id FROM normal_inbox_messages WHERE purge_run_id=?";
  const affected = `SELECT batch_id FROM normal_inbox_messages WHERE purge_run_id=?
    UNION SELECT id FROM normal_inbox_batches WHERE retired_run_id=?`;
  const statements = [env.DB.prepare(`UPDATE normal_inbox_messages SET purged_at=?,purge_run_id=?,summary=NULL,flags='[]',
    thread_key=NULL,thread_basis=NULL,thread_version=0,thread_limited=0 WHERE id IN
    (SELECT m.id FROM normal_inbox_messages m WHERE ${selection.where} ORDER BY m.observed_at,m.id LIMIT ${RETENTION_BATCH_LIMIT}) AND ${guard}`)
    .bind(now, runId, ...selection.values, runId),
  env.DB.prepare("UPDATE retention_runs SET purged_normal_messages=changes() WHERE id=? AND completed_at IS NULL").bind(runId),
  env.DB.prepare(`UPDATE normal_inbox_batches SET retired_at=?,retired_run_id=? WHERE id IN
    (SELECT m.id FROM normal_inbox_batches m WHERE ${normalStagingSelection(leaseTable)} ORDER BY m.created_at,m.id LIMIT ${RETENTION_BATCH_LIMIT}) AND ${guard}`)
    .bind(now, runId, now - NORMAL_STAGING_GRACE, runId),
  env.DB.prepare("UPDATE retention_runs SET retired_normal_batches=changes() WHERE id=? AND completed_at IS NULL").bind(runId)];
  // Membership is fixed by this run's tombstones, not recomputed after removing projections.
  for (const [field, size] of [["raw_key", "raw_bytes"], ["content_key", "content_bytes"]]) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO normal_inbox_object_deletions
    (object_key,batch_id,message_id,run_id,created_at,size_bytes) SELECT ${field},batch_id,id,?,?,${size} FROM normal_inbox_messages WHERE purge_run_id=?`).bind(runId, now, runId));
  for (const [field, size] of [["rawKey", "rawBytes"], ["contentKey", "contentBytes"]]) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO normal_inbox_object_deletions
    (object_key,batch_id,run_id,created_at,size_bytes) SELECT json_extract(j.value,'$.${field}'),b.id,?,?,json_extract(j.value,'$.${size}')
    FROM normal_inbox_batches b,json_each(b.manifest,'$.items') j WHERE b.retired_run_id=?
    AND json_type(j.value,'$.${field}')='text'`).bind(runId, now, runId));
  for (const table of ["normal_inbox_search", "normal_thread_links", "normal_message_subscriptions", "normal_message_labels", "normal_message_folders"]) {
    statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE message_id IN (${purged})`).bind(runId));
  }
  statements.push(env.DB.prepare(`UPDATE normal_inbox_state SET cache_generation=cache_generation+1
    WHERE account_id IN (SELECT account_id FROM normal_inbox_messages WHERE purge_run_id=?)`).bind(runId));
  if (leaseTable === "normal_receive_leases") statements.push(env.DB.prepare(`UPDATE normal_server_folder_state SET cache_generation=cache_generation+1
    WHERE EXISTS (SELECT 1 FROM normal_inbox_messages m WHERE m.account_id=normal_server_folder_state.account_id
      AND m.server_folder_id=normal_server_folder_state.server_folder_id AND m.purge_run_id=?)`).bind(runId));
  statements.push(env.DB.prepare(`UPDATE normal_inbox_batches AS b SET
    released_items=item_count-(SELECT COUNT(*) FROM normal_inbox_messages m WHERE m.batch_id=b.id AND m.purged_at IS NULL),
    manifest=json_set(manifest,'$.items',json(COALESCE((SELECT json_group_array(json(j.value)) FROM json_each(b.manifest,'$.items') j
      WHERE b.retired_at IS NULL AND EXISTS (SELECT 1 FROM normal_inbox_messages m WHERE m.id=json_extract(j.value,'$.id') AND m.batch_id=b.id AND m.purged_at IS NULL)), '[]')))
    WHERE id IN (${affected})`).bind(runId, runId));
  return statements;
}

export async function previewNormalRetention(env: Env, policy: RetentionPolicy, now: number) {
  const leaseTable = await normalReceiveLeaseTable(env), selection = normalRetentionSelection(policy, now, leaseTable);
  const counts: Record<string, number> = {}, more: Record<string, boolean> = {};
  const targets = [
    { view: "purgedNormalMessages", table: "normal_inbox_messages", where: selection.where, values: selection.values },
    { view: "retiredNormalBatches", table: "normal_inbox_batches", where: normalStagingSelection(leaseTable), values: [now - NORMAL_STAGING_GRACE] },
  ];
  const results = await env.DB.batch(targets.map(t => env.DB.prepare(`SELECT COUNT(*) n FROM
    (SELECT m.id FROM ${t.table} m WHERE ${t.where} LIMIT ${RETENTION_BATCH_LIMIT + 1})`).bind(...t.values)));
  for (const [i, result] of results.entries()) {
    const n = Number((result.results[0] as { n: number }).n);
    counts[targets[i].view] = Math.min(n, RETENTION_BATCH_LIMIT); more[targets[i].view] = n > RETENTION_BATCH_LIMIT;
  }
  return { counts, more };
}
