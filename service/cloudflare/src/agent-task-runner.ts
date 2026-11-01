import type { Env } from "./contracts";
import { HttpError } from "./http";
import { sendQuotaFence } from "./send-quota-fence";
import { smtpMime } from "./smtp-mime";
import { sendSmtp } from "./smtp-client";
import { agentTaskSource, agentTaskSourceFence } from "./agent-task-source";
import { AGENT_TASK_SELECT, storedAgentTaskInput, ownedAgentTask, type AgentTaskRow } from "./agent-task-store";
import { maintainAgentTasks, settleAgentTask, stopQueuedAgentTask } from "./agent-task-lifecycle";

async function preparationFailed(env: Env, row: AgentTaskRow, error: unknown) {
  const fresh = await ownedAgentTask(env, row.user_id, row.id);
  if (fresh.outgoing_state !== "queued" || fresh.job_state !== "queued") return;
  const code = error instanceof HttpError ? error.code : "agent_task_preparation_failed";
  const transient = !(error instanceof HttpError) || error.status >= 500 || error.status === 429 || error.code === "google_oauth_refresh_busy";
  if (transient && fresh.attempts < 4 && fresh.deadline_at > Date.now() / 1000 + 60) {
    await env.DB.prepare(`UPDATE agent_send_jobs SET attempts=attempts+1,next_attempt_at=unixepoch()+60,revision=revision+1,updated_at=unixepoch()
      WHERE id=? AND state='queued' AND revision=? AND EXISTS (SELECT 1 FROM agent_outgoing_messages WHERE id=? AND state='queued')`)
      .bind(fresh.job_id, fresh.revision, fresh.outgoing_id).run();
  } else await stopQueuedAgentTask(env, fresh, code);
}
async function dispatchAgentTask(env: Env, row: AgentTaskRow) {
  if (row.deadline_at <= Date.now() / 1000) { await stopQueuedAgentTask(env, row, "agent_task_expired"); return; }
  const input = storedAgentTaskInput(row), source = await agentTaskSource(env, row.user_id, input, true);
  if (source.endpoint.hash !== row.endpoint_hash || source.account.email_address !== row.from_address || source.service.email_address !== row.to_address) throw new HttpError(409, "agent_task_source_changed");
  const mime = smtpMime({ from: row.from_address, to: row.to_address, subject: row.subject, text: row.text_body, id: row.outgoing_id, createdAt: row.created_at });
  const live = agentTaskSourceFence(row.user_id, input, row.endpoint_hash), quota = sendQuotaFence(row.user_id, Math.floor(Date.now() / 1000), 1), token = crypto.randomUUID();
  // Crossing pending is the one-way dispatch boundary. A lost transaction receipt must never open a socket.
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE agent_outgoing_messages SET state='pending',dispatch_token=?,submitted_at=unixepoch(),updated_at=unixepoch()
      WHERE id=? AND state='queued' AND EXISTS (SELECT 1 FROM agent_send_jobs WHERE id=? AND state='queued' AND revision=? AND deadline_at>unixepoch())
      AND ${live.sql} AND ${source.authenticationFence.sql} AND ${quota.sql}`)
      .bind(token, row.outgoing_id, row.job_id, row.revision, ...live.values, ...source.authenticationFence.values, ...quota.values),
    env.DB.prepare(`UPDATE agent_send_jobs SET state='submitted',attempts=attempts+1,revision=revision+1,updated_at=unixepoch()
      WHERE id=? AND state='queued' AND EXISTS (SELECT 1 FROM agent_outgoing_messages WHERE id=? AND dispatch_token=? AND state='pending')`)
      .bind(row.job_id, row.outgoing_id, token),
  ]);
  if (!result[0].meta.changes) {
    const fresh = await ownedAgentTask(env, row.user_id, row.id); if (fresh.outgoing_state !== "queued") return;
    await agentTaskSource(env, row.user_id, input);
    if (!await env.DB.prepare(`SELECT 1 WHERE ${source.authenticationFence.sql}`).bind(...source.authenticationFence.values).first()) throw new HttpError(409, "google_oauth_account_changed");
    if (!await env.DB.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").bind(row.user_id).first()) throw new HttpError(409, "account_inactive");
    throw new HttpError(429, "send_quota_exceeded");
  }
  if (result[1].meta.changes !== 1) return;
  const sent = await sendSmtp(source.endpoint, source.config.username, source.authentication!, { from: row.from_address, recipients: [row.to_address], mime });
  try { await settleAgentTask(env, row, token, sent.state, sent.error); } catch { /* Pending remains a durable no-repeat guard, later shown as unknown. */ }
}
export async function runAgentTasks(env: Env) {
  await maintainAgentTasks(env);
  const { results } = await env.DB.prepare(`${AGENT_TASK_SELECT} WHERE j.state='queued' AND j.next_attempt_at<=unixepoch() ORDER BY j.next_attempt_at,j.id LIMIT 1`).all<AgentTaskRow>();
  for (const row of results) {
    try { await dispatchAgentTask(env, row); }
    catch (error) { await preparationFailed(env, row, error); }
  }
}
