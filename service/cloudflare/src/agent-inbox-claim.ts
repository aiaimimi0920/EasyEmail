import type { Env } from "./contracts";
import { HttpError } from "./http";
import type { AgentAccount } from "./agent-account-model";
import { agentInboxAccountFence, type AgentInboxAuthority } from "./agent-inbox-authority";
export { agentInboxAccountFence } from "./agent-inbox-authority";
import { tokenHash } from "./security";
import type { ImapCursor } from "./normal-imap-read";

export const agentInboxSourceHash = (account: Pick<AgentAccount, "endpoint_hash" | "username" | "email_address">) => tokenHash(JSON.stringify(["agent-inbox-v1", account.endpoint_hash, account.username, account.email_address, "INBOX"]));
export interface AgentInboxClaim {
  userId: string; accountId: string; revision: number; authority: AgentInboxAuthority; token: string; requestId: string; sourceHash: string;
  version: number; epochId: string | null; cursor: ImapCursor | null;
  authenticationFence?: { sql: string; values: (string | number)[] };
}
export function agentInboxClaimFence(claim: AgentInboxClaim) {
  const live = agentInboxAccountFence(claim.authority, claim.accountId, claim.revision);
  return { sql: `EXISTS(SELECT 1 FROM agent_inbox_state WHERE account_id=? AND version=? AND claim_token=? AND claim_revision=? AND claim_lease_until>unixepoch())
    AND EXISTS(SELECT 1 FROM agent_inbox_requests WHERE id=? AND user_id=? AND account_id=? AND account_revision=? AND state='pending') AND ${live.sql}
    AND ${claim.authenticationFence?.sql ?? "1"}`,
    values: [claim.accountId, claim.version, claim.token, claim.revision, claim.requestId, claim.userId, claim.accountId, claim.revision, ...live.values, ...(claim.authenticationFence?.values ?? [])] };
}
export async function claimAgentInbox(env: Env, authority: AgentInboxAuthority, account: AgentAccount, requestId: string): Promise<AgentInboxClaim> {
  const token = crypto.randomUUID(), live = agentInboxAccountFence(authority, account.id, account.revision);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO agent_inbox_state(account_id,user_id) SELECT ?,? WHERE ${live.sql} ON CONFLICT(account_id) DO NOTHING`).bind(account.id, authority.userId, ...live.values),
    env.DB.prepare(`UPDATE agent_inbox_state SET claim_token=?,claim_revision=?,request_id=?,claim_lease_until=unixepoch()+90
      WHERE account_id=? AND (claim_token IS NULL OR claim_lease_until<=unixepoch() OR claim_revision<>?) AND ${live.sql}`)
      .bind(token, account.revision, requestId, account.id, account.revision, ...live.values),
  ]);
  if (results[1].meta.changes !== 1) throw new HttpError(409, "agent_inbox_busy_or_changed");
  const row = await env.DB.prepare("SELECT * FROM agent_inbox_state WHERE account_id=? AND claim_token=?").bind(account.id, token)
    .first<{ source_hash: string | null; epoch_id: string | null; uid_validity: string | null; after_uid: number; version: number }>();
  if (!row) throw new HttpError(409, "agent_inbox_changed");
  const sourceHash = await agentInboxSourceHash(account), same = row.source_hash === sourceHash;
  return { userId: authority.userId, accountId: account.id, revision: account.revision, authority, token, requestId, sourceHash, version: row.version,
    epochId: same ? row.epoch_id : null, cursor: same && row.uid_validity ? { uidValidity: row.uid_validity, afterUid: row.after_uid } : null };
}
export async function releaseAgentInbox(env: Env, claim: AgentInboxClaim) {
  await env.DB.prepare("UPDATE agent_inbox_state SET claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL,request_id=NULL WHERE account_id=? AND claim_token=?")
    .bind(claim.accountId, claim.token).run();
}
