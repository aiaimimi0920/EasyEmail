import type { Env } from "./contracts";
import { HttpError } from "./http";
import type { AgentAccount } from "./agent-account-model";
import { decryptCredential, openVault } from "./mailbox-vault";
import { googleAuthentication } from "./google-oauth-refresh";
import { googleTargets } from "./google-oauth-target";
import type { MailAuthentication } from "./mail-authentication";

export const agentEndpointMatches = (account: AgentAccount, endpoint: { authentication?: "password" | "google-oauth2" }, username = account.username) =>
  (account.authentication === "google-oauth2") === (endpoint.authentication === "google-oauth2")
    && (account.authentication !== "google-oauth2" || username === account.email_address);
export async function agentMailAuthentication(env: Env, account: AgentAccount, cipher: string | null,
  context: { id: string; user_id: string; provider_id: string; purpose: string }, endpoint: { authentication?: "password" | "google-oauth2" }, username: string): Promise<{
    authentication: MailAuthentication; fence: { sql: string; values: (string | number)[] };
  }> {
  if (!agentEndpointMatches(account, endpoint, username)) throw new HttpError(409, "google_oauth_account_mismatch");
  if (account.authentication === "google-oauth2") {
    const reference = await openVault<{ oauthGrantId?: string }>(env, context, cipher);
    if (typeof reference.oauthGrantId !== "string" || Object.keys(reference).length !== 1 || reference.oauthGrantId !== account.oauth_grant_id)
      throw new HttpError(409, "google_oauth_reauthorization_required");
    return googleAuthentication(env, account, reference.oauthGrantId, googleTargets.agent);
  }
  const credential = await decryptCredential(env, context, cipher);
  if (!credential.token) throw new HttpError(409, "agent_credential_required");
  return { authentication: credential.token, fence: { sql: "1", values: [] } };
}
