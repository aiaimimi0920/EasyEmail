import type { Env } from "./contracts";
import type { RetentionPolicy } from "./retention-policy";
import { TEMPORARY_JOBS, type JobSource } from "./send-job-source";

// Reuse outgoing content policy; keep request hashes and action receipts as permanent replay guards.
export function sendJobRedaction(env: Env, policy: RetentionPolicy, now: number, runId: string, source: JobSource = TEMPORARY_JOBS) {
  if (!policy.enabled || policy.outgoingDays <= 0) return null;
  return env.DB.prepare(`UPDATE ${source.table} SET payload_json=NULL,attachments_json=NULL,content_purged_at=?
    WHERE id IN (SELECT j.id FROM ${source.table} j WHERE j.content_purged_at IS NULL AND j.updated_at<=?
      AND (j.state='cancelled' OR (j.state='failed' AND j.deadline_at<=?) OR (j.state='submitted' AND EXISTS
        (SELECT 1 FROM ${source.outgoing} o WHERE o.user_id=j.user_id AND o.request_key=j.outgoing_key AND o.state<>'pending')))
      ORDER BY j.updated_at,j.id LIMIT 200)
    AND EXISTS (SELECT 1 FROM retention_runs WHERE id=? AND completed_at IS NULL)`)
    .bind(now, now - policy.outgoingDays * 86400, now, runId);
}
