import { unixNow, type Env } from "./contracts";
import { HttpError } from "./http";
import type { AgentTaskInput } from "./agent-task-input";

export interface AgentTaskRow {
  id: string; user_id: string; service_id: string; service_version: number; sender_account_id: string; account_revision: number; smtp_revision: number;
  endpoint_hash: string; confirm_restricted: number; request_key: string; request_hash: string; correlation_key: string; thread_state: string;
  outgoing_id: string; rfc_message_id: string; from_address: string; to_address: string; subject: string; text_body: string; outgoing_state: string;
  error_code: string | null; submitted_at: number | null; content_purged_at: number | null; job_id: string; job_state: string; revision: number;
  attempts: number; next_attempt_at: number; deadline_at: number; created_at: number; updated_at: number; task_updated_at: number;
}
export const AGENT_TASK_SELECT = `SELECT t.*,t.state AS thread_state,o.id AS outgoing_id,o.rfc_message_id,o.from_address,o.to_address,o.subject,o.text_body,
  o.state AS outgoing_state,o.error_code,o.submitted_at,o.content_purged_at,j.id AS job_id,j.state AS job_state,j.revision,j.attempts,j.next_attempt_at,j.deadline_at,
  MAX(t.updated_at,o.updated_at,j.updated_at) AS task_updated_at
  FROM agent_threads t JOIN agent_outgoing_messages o ON o.user_id=t.user_id AND o.thread_id=t.id
  JOIN agent_send_jobs j ON j.user_id=t.user_id AND j.thread_id=t.id AND j.outgoing_id=o.id`;
export const agentTaskByKey = (env: Env, userId: string, key: string) => env.DB.prepare(`${AGENT_TASK_SELECT} WHERE t.user_id=? AND t.request_key=?`)
  .bind(userId, key).first<AgentTaskRow>();
export async function ownedAgentTask(env: Env, userId: string, id: string) {
  const row = await env.DB.prepare(`${AGENT_TASK_SELECT} WHERE t.user_id=? AND t.id=?`).bind(userId, id).first<AgentTaskRow>();
  if (!row) throw new HttpError(404, "not_found"); return row;
}
export const storedAgentTaskInput = (row: AgentTaskRow): AgentTaskInput => ({ serviceId: row.service_id, serviceVersion: row.service_version,
  senderAccountId: row.sender_account_id, accountRevision: row.account_revision, smtpRevision: row.smtp_revision,
  subject: row.subject, text: row.text_body, confirmRestricted: row.confirm_restricted === 1 });
export function agentTaskView(row: AgentTaskRow, detail = true, observedAt = unixNow()) {
  const stale = row.outgoing_state === "pending" && row.submitted_at! <= observedAt - 60;
  return { id: row.id, requestKey: row.request_key, serviceId: row.service_id, serviceVersion: row.service_version, senderAccountId: row.sender_account_id,
    accountRevision: row.account_revision, smtpRevision: row.smtp_revision, confirmRestricted: row.confirm_restricted === 1, threadState: stale ? "needs_attention" : row.thread_state,
    state: stale ? "unknown" : row.outgoing_state === "not_sent" ? "failed" : row.outgoing_state,
    error: stale ? "smtp_outcome_unknown" : row.error_code, revision: row.revision, outgoingId: row.outgoing_id, messageId: row.rfc_message_id,
    subject: row.subject, ...(detail ? { text: row.text_body, from: row.from_address, to: row.to_address } : {}),
    cancellable: row.job_state === "queued" && row.outgoing_state === "queued", retrySafe: false, delivery: "unconfirmed",
    attempts: row.attempts, nextAttemptAt: row.next_attempt_at, deadlineAt: row.deadline_at, createdAt: row.created_at, updatedAt: row.task_updated_at, contentPurgedAt: row.content_purged_at };
}
