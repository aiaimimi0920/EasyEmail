import { unixNow, type Env } from "./contracts";
import { HttpError } from "./http";
import type { AgentTaskInput } from "./agent-task-input";

export interface AgentFollowupRow {
  id: string; user_id: string; thread_id: string; thread_kind: "task" | "inbound"; account_id: string; service_id: string; route_hash: string;
  account_revision: number; smtp_revision: number; service_version: number; endpoint_hash: string; confirm_restricted: number; confirm_uncertain: number;
  thread_revision: number; request_key: string; request_hash: string; reply_type: "task" | "followup" | "incoming"; reply_id: string;
  in_reply_to: string; references_json: string; rfc_message_id: string; from_address: string; to_address: string; subject: string; text_body: string;
  state: string; revision: number; attempts: number; next_attempt_at: number; deadline_at: number; dispatch_token: string | null;
  submitted_at: number | null; error_code: string | null; created_at: number; updated_at: number; content_purged_at: number | null;
}
export const AGENT_FOLLOWUP_SELECT = `SELECT f.*,CASE WHEN s.task_thread_id IS NOT NULL THEN 'task' ELSE 'inbound' END AS thread_kind
  FROM agent_followups f JOIN agent_thread_sources s ON s.user_id=f.user_id AND s.thread_id=f.thread_id`;
export const agentFollowupByKey = (env: Env, userId: string, key: string) => env.DB.prepare(`${AGENT_FOLLOWUP_SELECT} WHERE f.user_id=? AND f.request_key=?`)
  .bind(userId, key).first<AgentFollowupRow>();
export async function ownedAgentFollowup(env: Env, userId: string, id: string) {
  const row = await env.DB.prepare(`${AGENT_FOLLOWUP_SELECT} WHERE f.user_id=? AND f.id=?`).bind(userId, id).first<AgentFollowupRow>();
  if (!row) throw new HttpError(404, "not_found"); return row;
}
export const storedAgentFollowupInput = (row: AgentFollowupRow): AgentTaskInput => ({ serviceId: row.service_id, serviceVersion: row.service_version,
  senderAccountId: row.account_id, accountRevision: row.account_revision, smtpRevision: row.smtp_revision,
  subject: row.subject, text: row.text_body, confirmRestricted: row.confirm_restricted === 1 });
export function agentFollowupView(row: AgentFollowupRow, detail = true) {
  const stale = row.state === "pending" && row.submitted_at! <= unixNow() - 60;
  return { id: row.id, requestKey: row.request_key, threadId: row.thread_id, threadKind: row.thread_kind, senderAccountId: row.account_id,
    serviceId: row.service_id, accountRevision: row.account_revision, smtpRevision: row.smtp_revision, serviceVersion: row.service_version,
    threadRevision: row.thread_revision, confirmRestricted: row.confirm_restricted === 1, confirmUncertain: row.confirm_uncertain === 1,
    replyToType: row.reply_type, replyToId: row.reply_id, messageId: row.rfc_message_id, inReplyTo: row.in_reply_to,
    state: stale ? "unknown" : row.state === "not_sent" ? "failed" : row.state, error: stale ? "smtp_outcome_unknown" : row.error_code,
    revision: row.revision, subject: row.subject, ...(detail ? { text: row.text_body, from: row.from_address, to: row.to_address } : {}),
    cancellable: row.state === "queued", retrySafe: false, delivery: "unconfirmed", attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at, deadlineAt: row.deadline_at, createdAt: row.created_at, updatedAt: row.updated_at, contentPurgedAt: row.content_purged_at };
}
