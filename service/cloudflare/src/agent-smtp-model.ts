import type { AgentAccount } from "./agent-account-model";

export const AGENT_SMTP_OPERATION_LIMIT = 10000;
export interface AgentSmtpConfig {
  account_id: string; user_id: string; account_revision: number; revision: number; endpoint_id: string; endpoint_hash: string;
  username: string; credential_cipher: string | null; enabled: number; updated_at: number;
}
export interface AgentSmtpOperation {
  user_id: string; request_key: string; id: string; account_id: string; request_hash: string;
  account_revision: number; revision: number | null; created_at: number; completed_at: number | null;
}
export function agentSmtpView(row: AgentSmtpConfig | null, account: AgentAccount) {
  return { accountId: account.id, scope: "agent" as const, authentication: account.authentication ?? "password",
    parentRevision: account.revision, accountRevision: row?.account_revision ?? account.revision, revision: row?.revision ?? 0,
    endpointId: row?.endpoint_id ?? "", username: row?.username ?? "", credentialConfigured: !!row?.credential_cipher,
    enabled: row?.enabled === 1, current: !!row && row.account_revision === account.revision, updatedAt: row?.updated_at ?? null };
}
export function agentSmtpOperationView(row: AgentSmtpOperation) {
  return { requestKey: row.request_key, accountId: row.account_id, kind: "PUT" as const,
    accountRevision: row.account_revision, revision: row.revision!, completedAt: row.completed_at! };
}
