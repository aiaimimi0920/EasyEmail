import type { Env } from "./contracts";
import { HttpError } from "./http";
import { MESSAGE_CONTENT_RESET } from "./message-tombstone";
import { RETENTION_BATCH_LIMIT, type RetentionPolicy } from "./retention-policy";
import { retentionTargets } from "./retention-targets";
import { previewNormalRetention } from "./normal-retention-store";

export interface RetentionRun {
  id: string; run_key: string; request_hash: string; config_revision: number; actor_id: string | null; trigger_kind: string;
  started_at: number; completed_at: number | null; expired_mailboxes: number; purged_messages: number; redacted_outgoing: number; pruned_audit: number;
  purged_normal_messages: number; retired_normal_batches: number;
}
export function retentionRunView(row: RetentionRun) {
  if (row.completed_at === null) throw new HttpError(503, "retention_run_incomplete");
  return { id: row.id, revision: row.config_revision, actorId: row.actor_id, trigger: row.trigger_kind,
    startedAt: row.started_at, completedAt: row.completed_at, batchLimit: RETENTION_BATCH_LIMIT,
    counts: { expiredMailboxes: row.expired_mailboxes, purgedMessages: row.purged_messages,
      redactedOutgoing: row.redacted_outgoing, prunedAudit: row.pruned_audit,
      purgedNormalMessages: row.purged_normal_messages, retiredNormalBatches: row.retired_normal_batches }, upstreamChanged: false };
}
export async function retentionRunByKey(env: Env, key: string): Promise<RetentionRun | null> {
  return env.DB.prepare("SELECT * FROM retention_runs WHERE run_key = ?").bind(key).first<RetentionRun>();
}
export async function lastRetentionRun(env: Env) {
  const row = await env.DB.prepare("SELECT * FROM retention_runs ORDER BY rowid DESC LIMIT 1").first<RetentionRun>();
  return row ? retentionRunView(row) : null;
}

export async function previewRetention(env: Env, policy: RetentionPolicy, now: number) {
  const counts: Record<string, number> = {}, more: Record<string, boolean> = {};
  const targets = retentionTargets(policy, now, MESSAGE_CONTENT_RESET);
  const rows = await env.DB.batch(targets.map((target) => env.DB.prepare(`SELECT COUNT(*) AS n FROM
    (SELECT id FROM ${target.table} WHERE ${target.where} ORDER BY ${target.order} LIMIT ${RETENTION_BATCH_LIMIT + 1})`).bind(...target.values)));
  for (const [index, result] of rows.entries()) {
    const n = Number((result.results[0] as { n: number }).n);
    counts[targets[index].view] = Math.min(n, RETENTION_BATCH_LIMIT); more[targets[index].view] = n > RETENTION_BATCH_LIMIT;
  }
  const normal = await previewNormalRetention(env, policy, now);
  return { counts: { ...counts, ...normal.counts }, more: { ...more, ...normal.more }, batchLimit: RETENTION_BATCH_LIMIT, checkedAt: now, upstreamChanged: false };
}
