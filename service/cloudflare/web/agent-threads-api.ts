import { ApiError, type Page } from "./api";
import { readAgentTask, type AgentTask } from "./agent-tasks-api";

export const agentThreadStates = { open: "处理中", needs_attention: "待人工关注", completed: "人工已完成", archived: "已归档" };
export type AgentThreadState = keyof typeof agentThreadStates;
interface ThreadBase {
  id: string;
  management: { state: AgentThreadState; revision: number; manual: boolean; updatedAt: number | null };
}
export type AgentThread = ThreadBase & ({ kind: "task"; task: AgentTask } | { kind: "inbound"; inbound: {
  accountId: string; accountRevision: number; epochId: string; seedMessageId: string; serviceId: string;
  serviceVersion: number; createdAt: number; memberActive: boolean;
} });
export const agentThreadTitle = (row: AgentThread) => row.kind === "task" ? row.task.subject || "内容已清理" : `入站线程 · ${row.id}`;
export interface AgentThreadAttempt { key: string; threadId: string; body: { expectedRevision: number; state: AgentThreadState }; uncertain: boolean }
export interface AgentThreadOperation { requestKey: string; threadId: string; state: AgentThreadState; revision: number; completedAt: number }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
const invalid = () => new ApiError(502, "agent_thread_response_invalid");
export function readAgentThread(value: unknown, detail = true): AgentThread {
  const row = object(object(value)?.thread), management = object(row?.management);
  if (!row || !uuid(row.id) || !["task", "inbound"].includes(String(row.kind)) || !management || !integer(management.revision)
    || typeof management.state !== "string" || !Object.hasOwn(agentThreadStates, management.state) || typeof management.manual !== "boolean") throw invalid();
  if (row.kind === "inbound") {
    const inbound = object(row.inbound);
    if (Object.hasOwn(row, "task") || !inbound || !uuid(inbound.accountId) || !uuid(inbound.epochId) || !uuid(inbound.seedMessageId) || !uuid(inbound.serviceId)
      || !integer(inbound.accountRevision, 1) || !integer(inbound.serviceVersion, 1) || !integer(inbound.createdAt) || typeof inbound.memberActive !== "boolean"
      || !management.manual || !integer(management.revision, 1) || !integer(management.updatedAt)) throw invalid();
    return row as unknown as AgentThread;
  }
  if (Object.hasOwn(row, "inbound")) throw invalid();
  const task = readAgentTask({ task: row.task }, undefined, detail);
  const fallback = task.threadState === "archived" ? "archived" : ["failed", "needs_attention"].includes(task.threadState) ? "needs_attention" : "open";
  if (task.id !== row.id || (management.manual ? !integer(management.revision, 1) || !integer(management.updatedAt)
    : management.revision !== 0 || management.updatedAt !== null || management.state !== fallback)) throw invalid();
  return row as unknown as AgentThread;
}
export function readAgentThreadPage(value: unknown, state = "", cursor = ""): Page<AgentThread> {
  const row = object(value), after = cursor.split(".")[0];
  if (!row || !Array.isArray(row.items) || row.items.length > 20 || row.nextCursor !== null && typeof row.nextCursor !== "string") throw invalid();
  const items = row.items.map(thread => readAgentThread({ thread }, false));
  if (items.some((item, i) => item.id <= (i ? items[i - 1].id : after) || state && item.management.state !== state)
    || row.nextCursor !== null && (!items.length || row.nextCursor !== `${items.at(-1)!.id}.${state || "all"}`)) throw invalid();
  return { items, nextCursor: row.nextCursor as string | null };
}
export function readAgentThreadOperation(value: unknown, attempt: AgentThreadAttempt): AgentThreadOperation {
  const row = object(object(value)?.operation);
  if (!row || row.requestKey !== attempt.key || row.threadId !== attempt.threadId || row.state !== attempt.body.state
    || row.revision !== attempt.body.expectedRevision + 1 || !integer(row.completedAt)) throw invalid();
  return row as unknown as AgentThreadOperation;
}
