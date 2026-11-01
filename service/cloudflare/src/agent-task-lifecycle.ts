import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { agentAccountCredentialFence } from "./agent-account-store";
import { ownedAgentTask, type AgentTaskRow } from "./agent-task-store";
import { readRetention } from "./retention-policy";

export function agentTaskProjection(env: Env, row: AgentTaskRow, outgoingState: string, threadState: string) {
  return [env.DB.prepare(`UPDATE agent_threads SET state=?,updated_at=unixepoch() WHERE id=? AND user_id=?
      AND EXISTS (SELECT 1 FROM agent_outgoing_messages WHERE id=? AND state=?)`).bind(threadState, row.id, row.user_id, row.outgoing_id, outgoingState),
    env.DB.prepare(`UPDATE agent_thread_messages SET parsed_status=? WHERE user_id=? AND thread_id=? AND outgoing_id=?
      AND EXISTS (SELECT 1 FROM agent_outgoing_messages WHERE id=? AND state=?)`).bind(outgoingState, row.user_id, row.id, row.outgoing_id, row.outgoing_id, outgoingState)];
}
export async function stopQueuedAgentTask(env: Env, row: AgentTaskRow, error: string | null, identity?: Identity) {
  const cancelled = !!identity, state = cancelled ? "cancelled" : "not_sent";
  const live = identity ? agentAccountCredentialFence(identity) : "1";
  await env.DB.batch([
    env.DB.prepare(`UPDATE agent_outgoing_messages SET state=?,error_code=?,updated_at=unixepoch() WHERE id=? AND user_id=? AND state='queued'
      AND EXISTS (SELECT 1 FROM agent_send_jobs WHERE id=? AND revision=? AND state='queued') AND ${live}`)
      .bind(state, error, row.outgoing_id, row.user_id, row.job_id, row.revision, ...(identity ? [identity.credentialId, identity.userId] : [])),
    env.DB.prepare(`UPDATE agent_send_jobs SET state=?,revision=revision+1,updated_at=unixepoch() WHERE id=? AND state='queued'
      AND EXISTS (SELECT 1 FROM agent_outgoing_messages WHERE id=? AND state=?)`).bind(cancelled ? "cancelled" : "failed", row.job_id, row.outgoing_id, state),
    ...agentTaskProjection(env, row, state, cancelled ? "archived" : "failed"),
  ]);
}
export async function cancelAgentTask(env: Env, identity: Identity, id: string, revision: number) {
  const row = await ownedAgentTask(env, identity.userId, id);
  if (row.outgoing_state === "cancelled") return row;
  if (row.revision !== revision || row.job_state !== "queued" || row.outgoing_state !== "queued") throw new HttpError(409, "agent_task_not_cancellable");
  try { await stopQueuedAgentTask(env, row, null, identity); } catch { throw new HttpError(503, "agent_task_storage_failed"); }
  const fresh = await ownedAgentTask(env, identity.userId, id);
  if (fresh.outgoing_state !== "cancelled") throw new HttpError(409, "agent_task_not_cancellable"); return fresh;
}
export async function settleAgentTask(env: Env, row: AgentTaskRow, token: string, state: string, error: string | null) {
  await env.DB.batch([
    env.DB.prepare("UPDATE agent_outgoing_messages SET state=?,error_code=?,updated_at=unixepoch() WHERE id=? AND state='pending' AND dispatch_token=?")
      .bind(state, error, row.outgoing_id, token),
    ...agentTaskProjection(env, row, state, state === "accepted" ? "awaiting_reply" : state === "unknown" ? "needs_attention" : "failed"),
  ]);
}
export async function maintainAgentTasks(env: Env) {
  const { results } = await env.DB.prepare(`SELECT t.id,t.user_id FROM agent_threads t JOIN agent_outgoing_messages o ON o.thread_id=t.id
    WHERE o.state='pending' AND o.submitted_at<=unixepoch()-60 ORDER BY o.submitted_at,o.id LIMIT 100`).all<{ id: string; user_id: string }>();
  for (const item of results) {
    const row = await ownedAgentTask(env, item.user_id, item.id);
    await env.DB.batch([env.DB.prepare("UPDATE agent_outgoing_messages SET state='unknown',error_code='smtp_outcome_unknown',updated_at=unixepoch() WHERE id=? AND state='pending' AND submitted_at<=unixepoch()-60")
      .bind(row.outgoing_id), ...agentTaskProjection(env, row, "unknown", "needs_attention")]);
  }
  const { policy, revision } = await readRetention(env);
  if (!policy.enabled || !policy.outgoingDays) return;
  const now = unixNow();
  await env.DB.prepare(`UPDATE agent_outgoing_messages SET from_address='',to_address='',subject='',text_body='',content_purged_at=?
    WHERE id IN (SELECT id FROM agent_outgoing_messages WHERE state NOT IN ('queued','pending') AND content_purged_at IS NULL AND updated_at<=? ORDER BY updated_at,id LIMIT 100)
    AND EXISTS (SELECT 1 FROM retention_policy WHERE id=1 AND revision=?)`).bind(now, now - policy.outgoingDays * 86400, revision).run();
}
