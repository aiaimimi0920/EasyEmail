import type { Env } from "./contracts";
import { HttpError } from "./http";
import { sendQuotaFence } from "./send-quota-fence";
import { smtpMime } from "./smtp-mime";
import { sendSmtp } from "./smtp-client";
import { agentTaskSource, agentTaskSourceFence } from "./agent-task-source";
import { agentThreadSourceFence, AGENT_THREAD_UNCERTAIN } from "./agent-thread-source";
import { AGENT_FOLLOWUP_SELECT, storedAgentFollowupInput, ownedAgentFollowup, type AgentFollowupRow } from "./agent-followup-store";
import { maintainAgentFollowups, stopQueuedAgentFollowup } from "./agent-followup-lifecycle";

async function preparationFailed(env: Env, row: AgentFollowupRow, error: unknown) {
  const fresh = await ownedAgentFollowup(env, row.user_id, row.id); if (fresh.state !== "queued") return;
  const code = error instanceof HttpError ? error.code : "agent_followup_preparation_failed";
  const transient = !(error instanceof HttpError) || error.status >= 500 || error.status === 429 || error.code === "google_oauth_refresh_busy";
  if (transient && fresh.attempts < 4 && fresh.deadline_at > Date.now() / 1000 + 60) {
    await env.DB.prepare(`UPDATE agent_followups SET attempts=attempts+1,next_attempt_at=unixepoch()+60,revision=revision+1,error_code=?,updated_at=unixepoch()
      WHERE id=? AND state='queued' AND revision=?`).bind(code, fresh.id, fresh.revision).run();
  } else await stopQueuedAgentFollowup(env, fresh, code);
}
async function dispatchAgentFollowup(env: Env, row: AgentFollowupRow) {
  if (row.deadline_at <= Date.now() / 1000) { await stopQueuedAgentFollowup(env, row, "agent_followup_expired"); return; }
  const input = storedAgentFollowupInput(row), source = await agentTaskSource(env, row.user_id, input, true);
  if (source.endpoint.hash !== row.endpoint_hash || source.account.email_address !== row.from_address || source.service.email_address !== row.to_address)
    throw new HttpError(409, "agent_followup_source_changed");
  const mime = smtpMime({ from: row.from_address, to: row.to_address, subject: row.subject, text: row.text_body, id: row.id, createdAt: row.created_at,
    threading: { inReplyTo: row.in_reply_to, references: JSON.parse(row.references_json) as string[] } });
  const live = agentTaskSourceFence(row.user_id, input, row.endpoint_hash), root = agentThreadSourceFence(row.user_id, row.thread_id, row.account_id, row.service_id, row.route_hash);
  const quota = sendQuotaFence(row.user_id, Math.floor(Date.now() / 1000), 1), token = crypto.randomUUID();
  // No socket until the caller receives the atomic one-way pending reservation ACK.
  const result = await env.DB.batch([env.DB.prepare(`UPDATE agent_followups SET state='pending',dispatch_token=?,submitted_at=unixepoch(),
    attempts=attempts+1,revision=revision+1,updated_at=unixepoch() WHERE id=? AND state='queued' AND revision=? AND deadline_at>unixepoch()
    AND ${live.sql} AND ${source.authenticationFence.sql} AND ${root.sql} AND ${quota.sql} AND (?=1 OR NOT ${AGENT_THREAD_UNCERTAIN})
    AND EXISTS(SELECT 1 FROM agent_accounts WHERE user_id=? AND id=? AND email_address=?)
    AND EXISTS(SELECT 1 FROM agent_services WHERE user_id=? AND id=? AND email_address=?)`)
    .bind(token, row.id, row.revision, ...live.values, ...source.authenticationFence.values, ...root.values, ...quota.values, row.confirm_uncertain, row.user_id, row.thread_id, row.user_id, row.thread_id,
      row.user_id, row.account_id, row.from_address, row.user_id, row.service_id, row.to_address)]);
  if (result[0].meta.changes !== 1) {
    const fresh = await ownedAgentFollowup(env, row.user_id, row.id); if (fresh.state !== "queued") return;
    await agentTaskSource(env, row.user_id, input);
    if (!await env.DB.prepare(`SELECT 1 WHERE ${source.authenticationFence.sql}`).bind(...source.authenticationFence.values).first()) throw new HttpError(409, "google_oauth_account_changed");
    if (!await env.DB.prepare(`SELECT 1 WHERE ${root.sql}`).bind(...root.values).first()) throw new HttpError(409, "agent_followup_source_changed");
    if (!await env.DB.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").bind(row.user_id).first()) throw new HttpError(409, "account_inactive");
    if (!row.confirm_uncertain && await env.DB.prepare(`SELECT 1 WHERE ${AGENT_THREAD_UNCERTAIN}`).bind(row.user_id, row.thread_id, row.user_id, row.thread_id).first())
      throw new HttpError(429, "agent_followup_uncertain_predecessor");
    throw new HttpError(429, "send_quota_exceeded");
  }
  const sent = await sendSmtp(source.endpoint, source.config.username, source.authentication!, { from: row.from_address, recipients: [row.to_address], mime });
  try {
    await env.DB.prepare(`UPDATE agent_followups SET state=?,error_code=?,revision=revision+1,updated_at=unixepoch()
      WHERE id=? AND state='pending' AND dispatch_token=?`).bind(sent.state, sent.error, row.id, token).run();
  } catch { /* Durable pending guard remains; maintenance exposes unknown without another SMTP submission. */ }
}
export async function runAgentFollowups(env: Env) {
  if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_followups'").first()) return;
  await maintainAgentFollowups(env);
  const { results } = await env.DB.prepare(`${AGENT_FOLLOWUP_SELECT} WHERE f.state='queued' AND f.next_attempt_at<=unixepoch()
    ORDER BY f.next_attempt_at,f.id LIMIT 1`).all<AgentFollowupRow>();
  for (const row of results) {
    try { await dispatchAgentFollowup(env, row); } catch (error) { await preparationFailed(env, row, error); }
  }
}
