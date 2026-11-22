import { api, ApiError, type Attachment, type Page } from "./api";
import { readAgentReview, type AgentReviewView } from "./agent-review-api";

export const agentInboxPath = (id: string) => `/agent-accounts/${id}`;
export const agentAssociations = { linked: "已关联任务", unmatched: "未匹配任务", ambiguous: "多个任务匹配，待核对",
  unknown_service: "未知服务", service_unavailable: "服务不可用", invalid_headers: "邮件头无效，待核对" };
export interface AgentIncoming {
  id: string; accountId: string; epochId: string; uid: number; subject: string; sender: string; recipient: string;
  receivedAt: number; observedAt: number; association: keyof typeof agentAssociations; authentication: "unverified";
  threadId: string | null; serviceId: string | null; review: AgentReviewView;
  inboundThread?: { id: string; active: boolean } | null;
  content?: { textBody: string; htmlBody: string; attachments: Attachment[]; attachmentsTruncated: boolean };
}
export interface AgentInboxPage extends Page<AgentIncoming> { epochId: string | null; accountRevision: number; sourceReady: boolean }
export const agentIncomingThreadId = (item: AgentIncoming) => item.inboundThread?.active ? item.inboundThread.id : item.review.effectiveThreadId;
export interface AgentInboxAttempt { key: string; accountId: string; revision: number; uncertain: boolean }
export interface AgentInboxOperation {
  id: string; requestKey: string; accountId: string; accountRevision: number; state: "pending" | "failed" | "committed";
  createdAt: number; finishedAt: number | null; errorCode: string | null;
  result: { batchId: string; accountRevision: number; epochId: string; stored: number; skipped: { uid: number; reason: string }[];
    cursor: { uidValidity: string; afterUid: number }; reset: boolean; complete: boolean } | null;
}
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const invalid = () => new ApiError(502, "agent_inbox_response_invalid");
export function readAgentInboxOperation(value: unknown, attempt: AgentInboxAttempt): AgentInboxOperation {
  const row = object(object(value)?.operation);
  if (!row || !uuid(row.id) || row.requestKey !== attempt.key || row.accountId !== attempt.accountId || row.accountRevision !== attempt.revision
    || !["pending", "failed", "committed"].includes(String(row.state)) || !integer(row.createdAt)
    || row.finishedAt !== null && !integer(row.finishedAt) || row.errorCode !== null && typeof row.errorCode !== "string") throw invalid();
  const result = object(row.result), cursor = object(result?.cursor);
  if (row.state === "committed") {
    if (!result || !cursor || !uuid(result.batchId) || !uuid(result.epochId) || result.accountRevision !== attempt.revision
      || !integer(result.stored, 0, 3) || !Array.isArray(result.skipped) || result.skipped.length > 3
      || result.skipped.some(item => !object(item) || !integer(item.uid, 1, 4294967295) || !["message_missing", "message_too_large"].includes(item.reason))
      || typeof result.reset !== "boolean" || typeof result.complete !== "boolean" || !integer(cursor.afterUid, 0, 4294967295)
      || typeof cursor.uidValidity !== "string" || !/^[1-9]\d{0,9}$/.test(cursor.uidValidity) || Number(cursor.uidValidity) > 4294967295
      || row.errorCode !== null || !integer(row.finishedAt)) throw invalid();
  } else if (row.result !== null || row.state === "failed" && typeof row.errorCode !== "string" || row.state === "pending" && row.errorCode !== null) throw invalid();
  return row as unknown as AgentInboxOperation;
}
export function readAgentIncoming(value: unknown, accountId: string, id?: string): AgentIncoming {
  const row = object(id ? object(value)?.message : value);
  if (!row || !uuid(row.id) || id && row.id !== id || row.accountId !== accountId || !uuid(row.epochId)
    || !integer(row.uid, 1, 4294967295) || !integer(row.receivedAt, -8640000000000, 8640000000000) || !integer(row.observedAt)
    || typeof row.subject !== "string" || row.subject.length > 4096 || typeof row.sender !== "string" || row.sender.length > 2048
    || typeof row.recipient !== "string" || row.recipient.length > 320 || !Object.hasOwn(agentAssociations, String(row.association))
    || row.authentication !== "unverified" || row.threadId !== null && !uuid(row.threadId) || row.serviceId !== null && !uuid(row.serviceId)
    || (row.association === "linked") !== (row.threadId !== null)) throw invalid();
  const inbound = object(row.inboundThread);
  if (row.inboundThread !== undefined && row.inboundThread !== null && (!inbound || !uuid(inbound.id) || typeof inbound.active !== "boolean")) throw invalid();
  const review = readAgentReview(row.review, String(row.association), row.threadId, inbound?.active === true);
  if (inbound?.active && review.effectiveThreadId !== null) throw invalid();
  if (id) {
    const content = object(row.content);
    if (!content || typeof content.textBody !== "string" || content.textBody.length > 131072 || typeof content.htmlBody !== "string" || content.htmlBody.length > 131072
      || typeof content.attachmentsTruncated !== "boolean" || !Array.isArray(content.attachments) || content.attachments.length > 100
      || content.attachments.some(part => !object(part) || typeof part.filename !== "string" || part.filename.length > 512
        || !integer(part.size) || typeof part.downloadAvailable !== "boolean")) throw invalid();
  }
  return row as unknown as AgentIncoming;
}
export async function agentIncomingPage(accountId: string, threadId: string, cursor = "", signal?: AbortSignal, review = ""): Promise<AgentInboxPage> {
  const params = new URLSearchParams(); if (cursor) params.set("cursor", cursor); if (threadId) params.set("threadId", threadId);
  if (review) params.set("review", review);
  const row = object(await api(`${agentInboxPath(accountId)}/messages?${params}`, "GET", undefined, undefined, signal));
  if (!row || !Array.isArray(row.items) || row.items.length > 20 || !integer(row.accountRevision, 1)
    || row.epochId !== null && !uuid(row.epochId) || typeof row.sourceReady !== "boolean" || row.sourceReady !== (row.epochId !== null)
    || row.nextCursor !== null && (typeof row.nextCursor !== "string" || row.nextCursor.length > 180)) throw invalid();
  const items = row.items.map(item => readAgentIncoming(item, accountId));
  if (items.some(item => item.epochId !== row.epochId || threadId && agentIncomingThreadId(item) !== threadId
    || review && item.review.needsAttention !== (review === "attention")) || new Set(items.map(item => item.id)).size !== items.length) throw invalid();
  return { items, accountRevision: row.accountRevision as number, epochId: row.epochId as string | null,
    sourceReady: row.sourceReady, nextCursor: row.nextCursor as string | null };
}
