import type { Env } from "./contracts";
import type { AgentInboxAuthority } from "./agent-inbox-authority";
import { HttpError } from "./http";
import { agentAccount, agentAccountContext } from "./agent-account-store";
import { imapEndpoint } from "./normal-account-input";
import { agentMailAuthentication, agentEndpointMatches } from "./agent-mail-authentication";
import { readImapMessages } from "./normal-imap-client";
import { planNormalInbox } from "./normal-inbox-plan";
import { agentInboxClaimFence, claimAgentInbox, releaseAgentInbox } from "./agent-inbox-claim";
import { stageAgentInbox, commitAgentInbox } from "./agent-inbox-store";

export async function syncAgentInbox(env: Env, authority: AgentInboxAuthority, accountId: string, revision: number, requestId: string) {
  const account = await agentAccount(env, authority.userId, accountId);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  if (account.revision !== revision || !account.enabled || !account.credential_cipher) throw new HttpError(409, "agent_inbox_changed");
  if (!env.INBOX) throw new HttpError(503, "agent_inbox_not_configured");
  const endpoint = await imapEndpoint(env, account.endpoint_id);
  if (!agentEndpointMatches(account, endpoint) || endpoint.hash !== account.endpoint_hash) throw new HttpError(409, "agent_inbox_changed");
  const claim = await claimAgentInbox(env, authority, account, requestId);
  try {
    const credential = await agentMailAuthentication(env, account, account.credential_cipher, agentAccountContext(accountId, authority.userId), endpoint, account.username);
    claim.authenticationFence = credential.fence;
    const live = agentInboxClaimFence(claim);
    if (!await env.DB.prepare(`SELECT 1 WHERE ${live.sql}`).bind(...live.values).first()) throw new HttpError(409, "agent_inbox_changed");
    const batch = await readImapMessages(endpoint, account.username, credential.authentication, claim.cursor);
    const plan = await planNormalInbox(claim, account.email_address, batch, "agent-inbox/v1");
    await stageAgentInbox(env, claim, plan);
    for (const object of plan.objects) if (!await env.INBOX.put(object.key, object.bytes, { sha256: object.sha256, onlyIf: { etagDoesNotMatch: "*" } }))
      throw new HttpError(503, "agent_inbox_storage_failed");
    await commitAgentInbox(env, claim, plan);
  } finally { await releaseAgentInbox(env, claim).catch(() => {}); }
}
