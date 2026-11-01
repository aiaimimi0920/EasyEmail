export interface AgentReviewFields {
  review_state: "attention" | "linked" | "dismissed" | null;
  review_thread_id: string | null; review_revision: number | null; review_updated_at: number | null;
  inbound_thread_id: string | null; inbound_review_revision: number | null;
}
export const AGENT_REVIEW_COLUMNS = "r.state AS review_state,r.thread_id AS review_thread_id,r.revision AS review_revision,r.updated_at AS review_updated_at,n.thread_id AS inbound_thread_id,n.review_revision AS inbound_review_revision";
export const AGENT_REVIEW_JOIN = `LEFT JOIN agent_incoming_reviews r ON r.user_id=m.user_id AND r.account_id=m.account_id AND r.message_id=m.id
  LEFT JOIN agent_inbound_messages n ON n.user_id=m.user_id AND n.account_id=m.account_id AND n.message_id=m.id`;
const ACTIVE_INBOUND = "(n.thread_id IS NOT NULL AND n.review_revision=COALESCE(r.revision,0))";
export const AGENT_REVIEW_TASK_THREAD = "CASE WHEN r.state='linked' THEN r.thread_id WHEN r.state IS NULL THEN m.thread_id ELSE NULL END";
export const AGENT_EFFECTIVE_THREAD = `CASE WHEN ${ACTIVE_INBOUND} THEN n.thread_id ELSE (${AGENT_REVIEW_TASK_THREAD}) END`;
export const AGENT_NEEDS_ATTENTION = `((r.state='attention' OR (r.state IS NULL AND m.association<>'linked')) AND NOT ${ACTIVE_INBOUND})`;
export const agentInboundMembership = (row: AgentReviewFields) => row.inbound_thread_id ? { id: row.inbound_thread_id,
  active: row.inbound_review_revision === (row.review_revision ?? 0) } : null;
export function agentReviewView(row: AgentReviewFields & { association: string; thread_id: string | null }) {
  return { revision: row.review_revision ?? 0, state: row.review_state ?? "unreviewed", threadId: row.review_thread_id ?? null,
    effectiveThreadId: row.review_state === "linked" ? row.review_thread_id : row.review_state ? null : row.thread_id,
    needsAttention: !agentInboundMembership(row)?.active && (row.review_state === "attention" || row.review_state === null && row.association !== "linked"), updatedAt: row.review_updated_at ?? null };
}
export interface AgentReviewOperation {
  id: string; user_id: string; account_id: string; message_id: string; request_key: string; request_hash: string;
  account_revision: number; epoch_id: string; state: "attention" | "linked" | "dismissed"; thread_id: string | null;
  revision: number | null; created_at: number; completed_at: number | null;
}
export const agentReviewOperationView = (row: AgentReviewOperation) => ({ requestKey: row.request_key, accountId: row.account_id, messageId: row.message_id,
  accountRevision: row.account_revision, epochId: row.epoch_id, state: row.state, threadId: row.thread_id, revision: row.revision, completedAt: row.completed_at });
