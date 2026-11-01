import { ApiError, type Page } from "./api";
import type { AgentTaskInput } from "./agent-tasks-api";
import type { AgentThread, AgentThreadState } from "./agent-threads-api";

export interface AgentFollowupInput extends AgentTaskInput {
  expectedThreadRevision: number; replyToType: "task" | "followup" | "incoming"; replyToId: string; confirmUncertain: boolean;
}
export interface AgentFollowupContext {
  threadId: string; threadKind: "task" | "inbound"; threadRevision: number; threadState: AgentThreadState;
  senderAccountId: string; accountRevision: number; smtpRevision: number; serviceId: string; serviceVersion: number;
  from: string; to: string; trustLevel: "unknown" | "trusted" | "restricted" | "blocked"; uncertain: boolean;
}
export interface AgentFollowup extends AgentTaskInput {
  id: string; requestKey: string; threadId: string; threadKind: "task" | "inbound"; threadRevision: number;
  replyToType: AgentFollowupInput["replyToType"]; replyToId: string; confirmUncertain: boolean;
  messageId: string; inReplyTo: string; state: string; error: string | null; revision: number;
  from?: string; to?: string; cancellable: boolean; retrySafe: false; delivery: "unconfirmed";
  attempts: number; nextAttemptAt: number; deadlineAt: number; createdAt: number; updatedAt: number; contentPurgedAt: number | null;
}
export interface AgentFollowupAttempt {
  key: string; threadId: string; threadKind: "task" | "inbound"; body: AgentFollowupInput;
  from: string; to: string; uncertain: boolean;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
const invalid = () => new ApiError(502, "agent_followup_response_invalid");
const states = ["queued", "pending", "accepted", "rejected", "unknown", "cancelled", "failed"];
const address = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 320 && !/[\s<>]/.test(value) && value.includes("@");
export const agentFollowupSubmitted = (row: { state: string }) => ["pending", "accepted", "rejected", "unknown"].includes(row.state);

export function readAgentFollowupContext(value: unknown, thread: AgentThread): AgentFollowupContext {
  const row = object(object(value)?.context), source = thread.kind === "task" ? thread.task : thread.inbound;
  const accountId = thread.kind === "task" ? thread.task.senderAccountId : thread.inbound.accountId;
  if (!row || row.threadId !== thread.id || row.threadKind !== thread.kind || row.threadRevision !== thread.management.revision
    || row.threadState !== thread.management.state || row.senderAccountId !== accountId || row.serviceId !== source.serviceId
    || !integer(row.accountRevision, 1) || !integer(row.smtpRevision) || !integer(row.serviceVersion, 1)
    || !address(row.from) || !address(row.to) || !["unknown", "trusted", "restricted", "blocked"].includes(String(row.trustLevel)) || typeof row.uncertain !== "boolean") throw invalid();
  return row as unknown as AgentFollowupContext;
}
export function readAgentFollowup(value: unknown, attempt?: AgentFollowupAttempt, detail = true): AgentFollowup {
  const row = object(object(value)?.followup);
  if (!row || !["id", "requestKey", "threadId", "senderAccountId", "serviceId", "replyToId"].every(key => uuid(row[key]))
    || !["accountRevision", "smtpRevision", "serviceVersion", "revision"].every(key => integer(row[key], 1))
    || !["threadRevision", "attempts", "nextAttemptAt", "deadlineAt", "createdAt", "updatedAt"].every(key => integer(row[key]))
    || !["task", "inbound"].includes(String(row.threadKind)) || !["task", "followup", "incoming"].includes(String(row.replyToType))
    || !states.includes(String(row.state)) || row.messageId !== `<${row.id}@easyemail.invalid>`
    || typeof row.inReplyTo !== "string" || row.inReplyTo.length > 998 || !/^<[^\s<>]+@[^\s<>]+>$/.test(row.inReplyTo)
    || typeof row.confirmRestricted !== "boolean" || typeof row.confirmUncertain !== "boolean"
    || row.cancellable !== (row.state === "queued") || row.retrySafe !== false || row.delivery !== "unconfirmed"
    || typeof row.subject !== "string" || row.subject.length > 200 || !(row.error === null || typeof row.error === "string")
    || !(row.contentPurgedAt === null || integer(row.contentPurgedAt))
    || detail && (typeof row.text !== "string" || row.text.length > 6000 || typeof row.from !== "string" || typeof row.to !== "string")
    || !detail && ["text", "from", "to"].some(key => Object.hasOwn(row, key))) throw invalid();
  if (row.contentPurgedAt !== null && (row.subject !== "" || detail && (row.text !== "" || row.from !== "" || row.to !== "") || ["queued", "pending"].includes(String(row.state)))) throw invalid();
  if (attempt && (row.requestKey !== attempt.key || row.threadId !== attempt.threadId || row.threadKind !== attempt.threadKind
    || ["serviceId", "serviceVersion", "senderAccountId", "accountRevision", "smtpRevision", "confirmRestricted", "confirmUncertain", "replyToType", "replyToId"]
      .some(key => row[key] !== attempt.body[key as keyof AgentFollowupInput]) || row.threadRevision !== attempt.body.expectedThreadRevision
    || row.contentPurgedAt === null && (row.subject !== attempt.body.subject || row.text !== attempt.body.text || row.from !== attempt.from || row.to !== attempt.to))) throw invalid();
  return row as unknown as AgentFollowup;
}
export function readAgentFollowupPage(value: unknown, thread: AgentThread, cursor = ""): Page<AgentFollowup> {
  const row = object(value);
  if (!row || !Array.isArray(row.items) || row.items.length > 20 || row.nextCursor !== null && !uuid(row.nextCursor)) throw invalid();
  const items = row.items.map(followup => readAgentFollowup({ followup }, undefined, false));
  if (items.some((item, i) => item.threadId !== thread.id || item.threadKind !== thread.kind || item.id <= (i ? items[i - 1].id : cursor))
    || row.nextCursor !== null && (!items.length || row.nextCursor !== items.at(-1)!.id)) throw invalid();
  return { items, nextCursor: row.nextCursor as string | null };
}
export function agentFollowupReceiptIdentity(row: AgentFollowup): AgentFollowupAttempt {
  return { key: row.requestKey, threadId: row.threadId, threadKind: row.threadKind, from: row.from!, to: row.to!, uncertain: false,
    body: { serviceId: row.serviceId, serviceVersion: row.serviceVersion, senderAccountId: row.senderAccountId,
      accountRevision: row.accountRevision, smtpRevision: row.smtpRevision, subject: row.subject, text: row.text,
      confirmRestricted: row.confirmRestricted, confirmUncertain: row.confirmUncertain, expectedThreadRevision: row.threadRevision,
      replyToType: row.replyToType, replyToId: row.replyToId } };
}
