import type { Env } from "./contracts";
import { HttpError } from "./http";
import { agentInboxClaimFence, type AgentInboxClaim } from "./agent-inbox-claim";
import { AGENT_INBOX_CAPACITY } from "./agent-inbox-capacity";
import type { InboxPlan } from "./normal-inbox-plan";
import { agentIncomingStatement, agentInboundReplyStatement } from "./agent-reply-association";

export async function stageAgentInbox(env: Env, claim: AgentInboxClaim, plan: InboxPlan) {
  const live = agentInboxClaimFence(claim);
  const result = await env.DB.prepare(`INSERT INTO agent_inbox_batches(id,user_id,account_id,request_id,source_hash,from_version,epoch_id,uid_validity,
    after_uid,state,item_count,storage_bytes,manifest,created_at) SELECT ?,?,?,?,?,?,?,?,?,'staged',?,?,?,unixepoch() WHERE ${live.sql} AND ${AGENT_INBOX_CAPACITY}`)
    .bind(claim.token, claim.userId, claim.accountId, claim.requestId, claim.sourceHash, claim.version, plan.epochId, plan.uidValidity, plan.afterUid,
      plan.manifest.items.length, plan.storageBytes, JSON.stringify(plan.manifest), ...live.values, claim.accountId, plan.manifest.items.length, plan.storageBytes).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "agent_inbox_changed_or_limit");
}
export async function commitAgentInbox(env: Env, claim: AgentInboxClaim, plan: InboxPlan) {
  // Migration fixtures and rolling upgrades can still use the task-only writer before 0048 is applied.
  const followups = !!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='agent_reply_candidates'").first();
  for (const item of plan.manifest.items) for (const [key, size, digest] of [[item.rawKey, item.rawBytes, item.rawSha256], [item.contentKey, item.contentBytes, item.contentSha256]] as const) {
    const head = await env.INBOX!.head(key), checksum = head?.checksums.sha256;
    const actual = checksum && Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, "0")).join("");
    if (!head || head.size !== size || actual !== digest) throw new HttpError(503, "agent_inbox_storage_failed");
  }
  const live = agentInboxClaimFence(claim), result = { batchId: claim.token, accountRevision: claim.revision, epochId: plan.epochId,
    cursor: { uidValidity: plan.uidValidity, afterUid: plan.afterUid }, stored: plan.manifest.items.length, skipped: plan.manifest.skipped, reset: plan.reset, complete: plan.complete };
  const committed = `EXISTS(SELECT 1 FROM agent_inbox_batches b JOIN agent_inbox_state s ON s.account_id=b.account_id
    WHERE b.id=? AND b.state='committed' AND s.version=b.from_version AND s.claim_token=b.id)`;
  const statements = [env.DB.prepare(`UPDATE agent_inbox_batches SET state='committed',committed_at=unixepoch() WHERE id=? AND state='staged' AND ${live.sql}`)
    .bind(claim.token, ...live.values), ...plan.manifest.items.flatMap(item => [agentIncomingStatement(env, claim, item, plan.epochId, plan.uidValidity, followups),
      ...(followups ? [agentInboundReplyStatement(env, claim, item)] : [])]),
    env.DB.prepare(`UPDATE agent_inbox_requests SET state='committed',result_json=?,finished_at=unixepoch(),error_code=NULL WHERE id=? AND state='pending' AND ${committed}`)
      .bind(JSON.stringify(result), claim.requestId, claim.token),
    env.DB.prepare(`UPDATE agent_inbox_state SET source_hash=?,epoch_id=?,uid_validity=?,after_uid=?,version=version+1,updated_at=unixepoch(),
      claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL,request_id=NULL WHERE account_id=? AND ${committed}`)
      .bind(claim.sourceHash, plan.epochId, plan.uidValidity, plan.afterUid, claim.accountId, claim.token)];
  try {
    const receipt = await env.DB.batch(statements);
    if (receipt[0].meta.changes === 1) return;
  } catch { /* Reconcile this exact request; a lost transaction acknowledgement is not a rollback. */ }
  if (!await env.DB.prepare("SELECT 1 FROM agent_inbox_requests WHERE id=? AND state='committed'").bind(claim.requestId).first()) throw new HttpError(503, "agent_inbox_storage_failed");
}
