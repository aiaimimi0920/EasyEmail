import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { agentAccountCredentialFence } from "./agent-account-store";
import { assertAgentThreadCredential } from "./agent-thread-store";
import { ownedAgentFollowup, type AgentFollowupRow } from "./agent-followup-store";
import { readRetention } from "./retention-policy";

export async function stopQueuedAgentFollowup(env: Env, row: AgentFollowupRow, error: string | null, identity?: Identity) {
  const live = identity ? agentAccountCredentialFence(identity) : "1";
  await env.DB.prepare(`UPDATE agent_followups SET state=?,error_code=?,revision=revision+1,updated_at=unixepoch()
    WHERE id=? AND user_id=? AND revision=? AND state='queued' AND ${live}`)
    .bind(identity ? "cancelled" : "not_sent", error, row.id, row.user_id, row.revision, ...(identity ? [identity.credentialId, identity.userId] : [])).run();
}
export async function cancelAgentFollowup(env: Env, identity: Identity, id: string, revision: number) {
  await assertAgentThreadCredential(env, identity);
  const row = await ownedAgentFollowup(env, identity.userId, id);
  if (row.state === "cancelled") return row;
  if (row.state !== "queued" || row.revision !== revision) throw new HttpError(409, "agent_followup_not_cancellable");
  try { await stopQueuedAgentFollowup(env, row, null, identity); } catch { throw new HttpError(503, "agent_followup_storage_failed"); }
  await assertAgentThreadCredential(env, identity);
  const fresh = await ownedAgentFollowup(env, identity.userId, id);
  if (fresh.state !== "cancelled") throw new HttpError(409, "agent_followup_not_cancellable"); return fresh;
}
export async function maintainAgentFollowups(env: Env) {
  await env.DB.prepare(`UPDATE agent_followups SET state='unknown',error_code='smtp_outcome_unknown',revision=revision+1,updated_at=unixepoch()
    WHERE id IN (SELECT id FROM agent_followups WHERE state='pending' AND submitted_at<=unixepoch()-60 ORDER BY submitted_at,id LIMIT 100)
    AND state='pending'`).run();
  const { policy, revision } = await readRetention(env); if (!policy.enabled || !policy.outgoingDays) return;
  const now = unixNow();
  await env.DB.prepare(`UPDATE agent_followups SET from_address='',to_address='',subject='',text_body='',content_purged_at=?
    WHERE id IN (SELECT id FROM agent_followups WHERE state NOT IN ('queued','pending') AND content_purged_at IS NULL AND updated_at<=?
      ORDER BY updated_at,id LIMIT 100) AND EXISTS(SELECT 1 FROM retention_policy WHERE id=1 AND revision=?)`)
    .bind(now, now - policy.outgoingDays * 86400, revision).run();
}
