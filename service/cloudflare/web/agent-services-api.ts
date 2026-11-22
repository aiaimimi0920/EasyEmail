import { ApiError } from "./api";

export interface AgentService {
  id: string; displayName: string; emailAddress: string; description: string | null; serviceKind: string;
  trustLevel: "unknown" | "trusted" | "restricted" | "blocked"; status: "active" | "disabled" | "archived";
  version: number; createdAt: number; updatedAt: number;
  defaultSenderAccountId: string | null;
}
export interface AgentServiceOperation {
  requestKey: string; serviceId: string; kind: "POST" | "PATCH" | "DELETE"; version: number; deleted: boolean; completedAt: number;
}
export interface AgentServiceAttempt { path: string; method: "POST" | "PATCH" | "DELETE"; body: Record<string, unknown>; key: string }
export interface AgentServiceFilter { query: string; trust: string; status: string }
export const agentTrustLabels = { unknown: "未确认", trusted: "信任", restricted: "受限", blocked: "阻止" };
export const agentStatusLabels = { active: "启用", disabled: "停用", archived: "归档" };

export function readAgentServiceReceipt(value: unknown, attempt: AgentServiceAttempt): AgentServiceOperation {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as { operation?: unknown }).operation : null;
  const invalid = () => new ApiError(502, "agent_service_receipt_invalid");
  if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid();
  const receipt = row as AgentServiceOperation;
  const expectedVersion = attempt.method === "POST" ? 1 : Number(attempt.body.expectedVersion) + 1;
  if (receipt.requestKey !== attempt.key || receipt.kind !== attempt.method || typeof receipt.serviceId !== "string" || !uuid.test(receipt.serviceId)
    || attempt.method !== "POST" && receipt.serviceId !== attempt.path.split("/").at(-1)
    || !Number.isSafeInteger(receipt.version) || receipt.version !== expectedVersion
    || receipt.deleted !== (attempt.method === "DELETE") || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt < 0) throw invalid();
  return receipt;
}
