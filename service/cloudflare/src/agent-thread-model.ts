import { HttpError } from "./http";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { agentTaskView, AGENT_TASK_SELECT, type AgentTaskRow } from "./agent-task-store";
import { agentInboundThreadView, type AgentInboundThreadRow } from "./agent-inbound-model";

export const AGENT_THREAD_STATES = ["open", "needs_attention", "completed", "archived"] as const;
export type AgentThreadState = typeof AGENT_THREAD_STATES[number];
export interface AgentThreadInput { expectedRevision: number; state: AgentThreadState }
export interface AgentThreadRow extends AgentTaskRow {
  thread_observed_at: number;
  management_state: AgentThreadState | null; management_revision: number | null; management_updated_at: number | null;
}
export const AGENT_THREAD_SELECT = `${AGENT_TASK_SELECT}
  LEFT JOIN agent_thread_management w ON w.user_id=t.user_id AND w.thread_id=t.id`;
// Keep the legacy task SELECT/DTO unchanged, including job revision and unknown delivery.
export const AGENT_THREAD_COLUMNS = AGENT_THREAD_SELECT.replace("SELECT t.*", "SELECT unixepoch() AS thread_observed_at,w.state AS management_state,w.revision AS management_revision,w.updated_at AS management_updated_at,t.*");
export const AGENT_THREAD_EFFECTIVE_STATE = `COALESCE(w.state,CASE WHEN t.state='archived' THEN 'archived'
  WHEN t.state IN ('failed','needs_attention') OR (o.state='pending' AND o.submitted_at<=unixepoch()-60) THEN 'needs_attention' ELSE 'open' END)`;
export function agentThreadView(row: AgentThreadRow | AgentInboundThreadRow, detail = true) {
  if ("seed_message_id" in row) return agentInboundThreadView(row);
  const task = agentTaskView(row, detail, row.thread_observed_at);
  const fallback = task.threadState === "archived" ? "archived" : ["failed", "needs_attention"].includes(task.threadState) ? "needs_attention" : "open";
  return { id: row.id, kind: "task", management: { state: row.management_state ?? fallback,
    revision: row.management_revision ?? 0, manual: row.management_state !== null, updatedAt: row.management_updated_at }, task };
}
export function agentThreadInput(body: Record<string, unknown>): AgentThreadInput {
  if (Object.keys(body).sort().join(",") !== "expectedRevision,state" || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 0 || (body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
    || !AGENT_THREAD_STATES.includes(body.state as AgentThreadState)) throw new HttpError(400, "invalid_agent_thread_request");
  return { expectedRevision: body.expectedRevision as number, state: body.state as AgentThreadState };
}
export function agentThreadPage(url: URL) {
  const params = url.searchParams, state = params.get("state") ?? "", limit = params.get("limit") ?? "20", cursor = params.get("cursor");
  if ([...params.keys()].some(name => !["state", "limit", "cursor"].includes(name) || params.getAll(name).length !== 1)
    || params.has("state") && !AGENT_THREAD_STATES.includes(state as AgentThreadState)
    || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 20) throw new HttpError(400, "invalid_filter");
  const pieces = cursor?.split(".");
  if (pieces && (pieces.length !== 2 || !AGENT_ACCOUNT_UUID.test(pieces[0]) || pieces[1] !== (state || "all"))) throw new HttpError(400, "invalid_cursor");
  return { state, limit: Number(limit), cursor: pieces?.[0] ?? null };
}
export interface AgentThreadOperation {
  id: string; user_id: string; thread_id: string; request_key: string; request_hash: string;
  state: AgentThreadState; revision: number | null; completed_at: number | null;
}
export const agentThreadOperationView = (row: AgentThreadOperation) => ({ requestKey: row.request_key, threadId: row.thread_id,
  state: row.state, revision: row.revision, completedAt: row.completed_at });
