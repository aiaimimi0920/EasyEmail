import type { Env } from "./contracts";
import { HttpError } from "./http";
import { decryptCredential, openVault } from "./mailbox-vault";
import type { NormalAccount } from "./normal-account-model";
import { googleAuthentication } from "./google-oauth-refresh";
import type { MailAuthentication } from "./mail-authentication";

interface Context { id: string; user_id: string; provider_id: string; purpose: string }
export async function normalMailAuthentication(env: Env, account: NormalAccount, cipher: string | null, context: Context,
  endpoint: { authentication?: "password" | "google-oauth2" }, username: string): Promise<{
    authentication: MailAuthentication; fence: { sql: string; values: (string | number)[] };
  }> {
  if (account.authentication === "google-oauth2") {
    if (endpoint.authentication !== "google-oauth2" || username !== account.email_address) throw new HttpError(409, "google_oauth_account_mismatch");
    const reference = await openVault<{ oauthGrantId?: string }>(env, context, cipher);
    if (typeof reference.oauthGrantId !== "string" || Object.keys(reference).length !== 1 || reference.oauthGrantId !== account.oauth_grant_id)
      throw new HttpError(409, "google_oauth_reauthorization_required");
    return googleAuthentication(env, account, reference.oauthGrantId);
  }
  if (endpoint.authentication === "google-oauth2") throw new HttpError(409, "google_oauth_account_mismatch");
  const credential = await decryptCredential(env, context, cipher);
  if (!credential.token) throw new HttpError(409, "normal_credential_required");
  return { authentication: credential.token, fence: { sql: "1", values: [] } };
}
