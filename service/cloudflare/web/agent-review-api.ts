import { api, ApiError, type Page } from "./api";

export type AgentReviewState = "attention" | "linked" | "dismissed";
export interface AgentReviewInput { accountRevision: number; epochId: string; expectedRevision: number; state: AgentReviewState; threadId: string | null }
export interface AgentReviewAttempt { key: string; accountId: string; messageId: string; body: AgentReviewInput; uncertain: boolean }
export interface AgentReviewOperation {
  requestKey: string; accountId: string; messageId: string; accountRevision: number; epochId: string;
  state: AgentReviewState; threadId: string | null; revision: number; completedAt: number;
}
export interface AgentReviewView {
  revision: number; state: "unreviewed" | AgentReviewState; threadId: string | null;
  effectiveThreadId: string | null; needsAttention: boolean; updatedAt: number | null;
}
export interface AgentReviewTarget { id: string; subject: string; sender: string; recipient: string; state: string; submittedAt: number }
export const agentReviewLabels = { unreviewed: "未人工处理", attention: "待人工关注", linked: "人工已关联", dismissed: "已忽略" };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
const invalid = () => new ApiError(502, "agent_review_response_invalid");
export function readAgentReview(value: unknown, association: string, originalThreadId: unknown, inboundActive = false): AgentReviewView {
  const row = object(value);
  if (!row || !integer(row.revision) || typeof row.state !== "string" || !Object.hasOwn(agentReviewLabels, row.state)
    || row.threadId !== null && !uuid(row.threadId) || row.effectiveThreadId !== null && !uuid(row.effectiveThreadId)
    || typeof row.needsAttention !== "boolean" || row.updatedAt !== null && !integer(row.updatedAt)
    || (row.state === "unreviewed" ? row.revision !== 0 || row.threadId !== null || row.updatedAt !== null
      : !integer(row.revision, 1) || !integer(row.updatedAt) || (row.state === "linked") !== (row.threadId !== null))
    || row.effectiveThreadId !== (row.state === "linked" ? row.threadId : row.state === "unreviewed" ? originalThreadId : null)
    || row.needsAttention !== (!inboundActive && (row.state === "attention" || row.state === "unreviewed" && association !== "linked"))) throw invalid();
  return row as unknown as AgentReviewView;
}
export function readAgentReviewOperation(value: unknown, attempt: AgentReviewAttempt): AgentReviewOperation {
  const row = object(object(value)?.operation), body = attempt.body;
  if (!row || row.requestKey !== attempt.key || row.accountId !== attempt.accountId || row.messageId !== attempt.messageId
    || row.accountRevision !== body.accountRevision || row.epochId !== body.epochId || row.state !== body.state || row.threadId !== body.threadId
    || row.revision !== body.expectedRevision + 1 || !integer(row.completedAt)) throw invalid();
  return row as unknown as AgentReviewOperation;
}
export async function agentReviewTargets(accountId: string, messageId: string, cursor: string, signal: AbortSignal): Promise<Page<AgentReviewTarget>> {
  const value = object(await api(`/agent-accounts/${accountId}/messages/${messageId}/review-targets${cursor ? `?cursor=${cursor}` : ""}`, "GET", undefined, undefined, signal));
  if (!value || !Array.isArray(value.items) || value.items.length > 20 || value.nextCursor !== null && !uuid(value.nextCursor)
    || value.items.some(item => { const row = object(item); return !row || !uuid(row.id) || cursor && String(row.id) <= cursor
      || typeof row.subject !== "string" || row.subject.length > 200 || typeof row.sender !== "string" || row.sender.length > 320
      || typeof row.recipient !== "string" || row.recipient.length > 320 || typeof row.state !== "string" || !integer(row.submittedAt); })
    || new Set(value.items.map(row => row.id)).size !== value.items.length
    || value.nextCursor !== null && value.nextCursor !== value.items.at(-1)?.id) throw invalid();
  return value as unknown as Page<AgentReviewTarget>;
}
