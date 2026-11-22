import { HttpError } from "./http";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import type { AgentThreadState } from "./agent-thread-model";

export interface AgentInboundInput {
  accountRevision: number; epochId: string; expectedRevision: number;
  serviceId: string; serviceVersion: number; confirmRestricted: boolean;
}
export function agentInboundInput(body: Record<string, unknown>): AgentInboundInput {
  if (Object.keys(body).sort().join(",") !== "accountRevision,confirmRestricted,epochId,expectedRevision,serviceId,serviceVersion"
    || ![body.accountRevision, body.serviceVersion].every(value => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) < Number.MAX_SAFE_INTEGER)
    || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER
    || typeof body.epochId !== "string" || !AGENT_ACCOUNT_UUID.test(body.epochId)
    || typeof body.serviceId !== "string" || !AGENT_ACCOUNT_UUID.test(body.serviceId) || typeof body.confirmRestricted !== "boolean")
    throw new HttpError(400, "invalid_agent_inbound_request");
  return { accountRevision: body.accountRevision as number, epochId: body.epochId, expectedRevision: body.expectedRevision as number,
    serviceId: body.serviceId, serviceVersion: body.serviceVersion as number, confirmRestricted: body.confirmRestricted };
}
export interface AgentInboundOperation {
  id: string; user_id: string; account_id: string; message_id: string; request_key: string; request_hash: string;
  thread_id: string; account_revision: number; epoch_id: string; review_revision: number;
  service_id: string; service_version: number; confirm_restricted: number; created_at: number; completed_at: number | null;
}
export const agentInboundOperationView = (row: AgentInboundOperation) => ({ requestKey: row.request_key, threadId: row.thread_id,
  accountId: row.account_id, messageId: row.message_id, accountRevision: row.account_revision, epochId: row.epoch_id,
  reviewRevision: row.review_revision, serviceId: row.service_id, serviceVersion: row.service_version, confirmRestricted: row.confirm_restricted === 1, completedAt: row.completed_at });

export interface AgentInboundThreadRow {
  id: string; user_id: string; account_id: string; account_revision: number; epoch_id: string; seed_message_id: string;
  service_id: string; service_version: number; state: AgentThreadState; revision: number; created_at: number; updated_at: number; member_active: number;
}
export const AGENT_INBOUND_THREAD_SELECT = `SELECT i.*,EXISTS(SELECT 1 FROM agent_inbound_messages n
  LEFT JOIN agent_incoming_reviews r ON r.user_id=n.user_id AND r.account_id=n.account_id AND r.message_id=n.message_id
  WHERE n.user_id=i.user_id AND n.thread_id=i.id AND n.message_id=i.seed_message_id AND n.review_revision=COALESCE(r.revision,0)) AS member_active
  FROM agent_inbound_threads i`;
export const agentInboundThreadView = (row: AgentInboundThreadRow) => ({ id: row.id, kind: "inbound" as const,
  management: { state: row.state, revision: row.revision, manual: true, updatedAt: row.updated_at },
  inbound: { accountId: row.account_id, accountRevision: row.account_revision, epochId: row.epoch_id, seedMessageId: row.seed_message_id,
    serviceId: row.service_id, serviceVersion: row.service_version, createdAt: row.created_at, memberActive: row.member_active === 1 } });
