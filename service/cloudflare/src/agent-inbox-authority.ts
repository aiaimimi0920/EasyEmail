import type { Identity } from "./contracts";
import { agentAccountCredentialFence } from "./agent-account-store";

export interface AgentInboxAutomationAuthority {
  kind: "automation"; userId: string; accountId: string; accountRevision: number; revision: number;
  runToken: string; requestId: string; sourceHash: string; endpointHash: string; username: string; emailAddress: string;
}
export type AgentInboxAuthority = Identity | AgentInboxAutomationAuthority;
export function agentInboxAccountFence(authority: AgentInboxAuthority, accountId: string, revision: number) {
  const account = `EXISTS(SELECT 1 FROM agent_accounts WHERE user_id=? AND id=? AND revision=? AND enabled=1 AND deleted_at IS NULL AND credential_cipher IS NOT NULL)`;
  const values = [authority.userId, accountId, revision];
  if (authority.kind !== "automation") return { sql: `${account} AND ${agentAccountCredentialFence(authority)}`,
    values: [...values, authority.credentialId, authority.userId] };
  return { sql: `${account} AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')
    AND EXISTS(SELECT 1 FROM agent_inbox_automation WHERE user_id=? AND account_id=? AND account_id=? AND revision=?
      AND account_revision=? AND account_revision=? AND enabled=1 AND source_hash=? AND run_token=? AND run_request_id=? AND lease_until>unixepoch())
    AND EXISTS(SELECT 1 FROM agent_accounts WHERE id=? AND endpoint_hash=? AND username=? AND email_address=?)`,
    values: [...values, authority.userId, authority.userId, accountId, authority.accountId, authority.revision,
      revision, authority.accountRevision, authority.sourceHash, authority.runToken, authority.requestId,
      accountId, authority.endpointHash, authority.username, authority.emailAddress] };
}
