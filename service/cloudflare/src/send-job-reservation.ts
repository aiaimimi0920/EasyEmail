import type { Env } from "./contracts";
import { HttpError } from "./http";
import { NORMAL_JOBS, TEMPORARY_JOBS } from "./send-job-source";

export interface JobClaim { id: string; user_id: string; claim_token: string; source?: "normal" }
const sourceOf = (claim: JobClaim) => claim.source === "normal" ? NORMAL_JOBS : TEMPORARY_JOBS;
export function jobSendFence(claim?: JobClaim) {
  return claim ? {
    sql: `EXISTS (SELECT 1 FROM ${sourceOf(claim).table} WHERE id=? AND user_id=? AND state='preparing' AND claim_token=? AND lease_until>unixepoch() AND deadline_at>unixepoch())`,
    values: [claim.id, claim.user_id, claim.claim_token],
  } : { sql: "1", values: [] };
}
export async function reserveJobSend(env: Env, claim: JobClaim, id: string, statement: D1PreparedStatement) {
  const source = sourceOf(claim);
  // The job pin hands over to outgoing pending in the same transaction. Never dispatch if the receipt is lost.
  const results = await env.DB.batch([statement, env.DB.prepare(`UPDATE ${source.table} SET state='submitted',outgoing_id=?,
    claim_token=NULL,lease_until=NULL,revision=revision+1,updated_at=unixepoch(),error_code=NULL
    WHERE id=? AND user_id=? AND state='preparing' AND claim_token=?
      AND EXISTS (SELECT 1 FROM ${source.outgoing} WHERE id=? AND user_id=?)`)
    .bind(id, claim.id, claim.user_id, claim.claim_token, id, claim.user_id)]);
  if (results[0].meta.changes && results[1].meta.changes !== 1) throw new HttpError(503, "send_job_storage_failed");
  return results[0];
}
