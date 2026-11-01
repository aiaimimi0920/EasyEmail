import { ApiError, type Page } from "./api";

export interface AgentTaskInput { serviceId: string; serviceVersion: number; senderAccountId: string; accountRevision: number; smtpRevision: number; subject: string; text: string; confirmRestricted: boolean }
export interface AgentTaskAttempt { key: string; body: AgentTaskInput; uncertain: boolean }
export interface AgentTask extends AgentTaskInput {
  id: string; requestKey: string; outgoingId: string; messageId: string; state: string; threadState: string; error: string | null; revision: number;
  from?: string; to?: string; cancellable: boolean; retrySafe: false; delivery: "unconfirmed"; attempts: number; nextAttemptAt: number; deadlineAt: number;
  createdAt: number; updatedAt: number; contentPurgedAt: number | null;
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
const invalid = () => new ApiError(502, "agent_task_response_invalid");
const threads: Record<string, string> = { queued: "draft", pending: "draft", accepted: "awaiting_reply", rejected: "failed", unknown: "needs_attention", cancelled: "archived", failed: "failed" };
export function readAgentTask(value: unknown, attempt?: Pick<AgentTaskAttempt, "key" | "body">, detail = true): AgentTask {
  const row = object(object(value)?.task);
  if (!row || !["id", "requestKey", "serviceId", "senderAccountId", "outgoingId"].every(key => uuid(row[key]))
    || !["serviceVersion", "accountRevision", "smtpRevision", "revision"].every(key => integer(row[key], 1))
    || !["attempts", "nextAttemptAt", "deadlineAt", "createdAt", "updatedAt"].every(key => integer(row[key]))
    || typeof row.state !== "string" || !Object.hasOwn(threads, row.state) || row.threadState !== threads[row.state]
    || row.messageId !== `<${row.outgoingId}@easyemail.invalid>` || typeof row.subject !== "string" || row.subject.length > 200
    || typeof row.confirmRestricted !== "boolean" || row.cancellable !== (row.state === "queued") || row.retrySafe !== false || row.delivery !== "unconfirmed"
    || !(row.error === null || typeof row.error === "string") || !(row.contentPurgedAt === null || integer(row.contentPurgedAt))
    || detail && (typeof row.text !== "string" || row.text.length > 6000 || typeof row.from !== "string" || typeof row.to !== "string")) throw invalid();
  if (attempt && (row.requestKey !== attempt.key || ["serviceId", "serviceVersion", "senderAccountId", "accountRevision", "smtpRevision", "confirmRestricted"]
    .some(key => row[key] !== attempt.body[key as keyof AgentTaskInput]) || row.contentPurgedAt === null && (row.subject !== attempt.body.subject || row.text !== attempt.body.text))) throw invalid();
  return row as unknown as AgentTask;
}
export function readAgentTaskPage(value: unknown): Page<AgentTask> {
  const row = object(value);
  if (!row || !Array.isArray(row.items) || row.items.length > 100 || row.nextCursor !== null && !uuid(row.nextCursor)) throw invalid();
  const items = row.items.map(task => readAgentTask({ task }, undefined, false));
  if (new Set(items.map(task => task.id)).size !== items.length) throw invalid(); return { items, nextCursor: row.nextCursor as string | null };
}
export const agentTaskStates: Record<string, string> = { queued: "等待派发", pending: "提交中，结果待核对", accepted: "SMTP 已接受，送达未确认",
  rejected: "SMTP 已拒绝", unknown: "提交结果未知，不自动重发", cancelled: "已取消派发", failed: "未提交，任务失败" };
