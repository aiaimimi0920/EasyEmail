export const AGENT_SERVICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AGENT_TRUST_LEVELS = ["unknown", "trusted", "restricted", "blocked"] as const;
export const AGENT_SERVICE_STATUSES = ["active", "disabled", "archived"] as const;
export const AGENT_SERVICE_LIMIT = 256;
export const AGENT_SERVICE_OPERATION_LIMIT = 10000;
export type AgentTrustLevel = typeof AGENT_TRUST_LEVELS[number];
export type AgentServiceStatus = typeof AGENT_SERVICE_STATUSES[number];
export interface AgentServiceRow {
  user_id: string; id: string; display_name: string; email_address: string; description: string | null;
  service_kind: string; trust_level: AgentTrustLevel; status: AgentServiceStatus; version: number;
  created_at: number; updated_at: number; deleted_at: number | null;
  default_sender_account_id: string | null;
}
export interface AgentServiceOperation {
  user_id: string; request_key: string; id: string; request_hash: string; kind: "POST" | "PATCH" | "DELETE";
  service_id: string | null; version: number | null; deleted: number; created_at: number; completed_at: number | null;
}
export const agentServiceView = (row: AgentServiceRow) => ({ id: row.id, displayName: row.display_name, emailAddress: row.email_address,
  description: row.description, serviceKind: row.service_kind, trustLevel: row.trust_level, status: row.status, version: row.version,
  defaultSenderAccountId: row.default_sender_account_id, createdAt: row.created_at, updatedAt: row.updated_at });
export const AGENT_SERVICE_SELECT = `SELECT *, (SELECT account_id FROM agent_service_senders d
  WHERE d.user_id=agent_services.user_id AND d.service_id=agent_services.id) AS default_sender_account_id FROM agent_services`;
export const agentServiceOperationView = (row: AgentServiceOperation) => ({ requestKey: row.request_key, serviceId: row.service_id,
  kind: row.kind, version: row.version, deleted: row.deleted === 1, completedAt: row.completed_at });
