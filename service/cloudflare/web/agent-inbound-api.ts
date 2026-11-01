import { ApiError } from "./api";

export interface AgentInboundInput {
  accountRevision: number; epochId: string; expectedRevision: number; serviceId: string; serviceVersion: number; confirmRestricted: boolean;
}
export interface AgentInboundAttempt { key: string; accountId: string; messageId: string; body: AgentInboundInput; uncertain: boolean }
export interface AgentInboundOperation {
  requestKey: string; threadId: string; accountId: string; messageId: string; accountRevision: number; epochId: string;
  reviewRevision: number; serviceId: string; serviceVersion: number; confirmRestricted: boolean; completedAt: number;
}
export function readAgentInboundOperation(value: unknown, attempt: AgentInboundAttempt): AgentInboundOperation {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as { operation?: AgentInboundOperation }).operation : null, body = attempt.body;
  if (!row || typeof row !== "object" || Array.isArray(row) || row.requestKey !== attempt.key || row.accountId !== attempt.accountId || row.messageId !== attempt.messageId
    || row.accountRevision !== body.accountRevision || row.epochId !== body.epochId || row.reviewRevision !== body.expectedRevision
    || row.serviceId !== body.serviceId || row.serviceVersion !== body.serviceVersion || row.confirmRestricted !== body.confirmRestricted
    || typeof row.threadId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.threadId)
    || !Number.isSafeInteger(row.completedAt) || row.completedAt < 0) throw new ApiError(502, "agent_inbound_response_invalid");
  return row;
}
