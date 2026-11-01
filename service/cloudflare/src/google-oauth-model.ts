import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { googleTargets, type GoogleScope, type GoogleTarget } from "./google-oauth-target";

export interface GoogleAttempt {
  id: string; user_id: string; account_id: string; session_hash: string; request_hash: string; account_revision: number;
  config_hash: string; state_hash: string; secret_cipher: string | null; state: "pending" | "exchanging" | "completed" | "failed";
  claim: string | null; exchange_until: number | null; result_revision: number | null; error_code: string | null; expires_at: number;
}
export interface GoogleGrant {
  id: string; user_id: string; account_id: string; config_hash: string; endpoint_hash: string; username: string; email_address: string;
  state: "active" | "reauthorize" | "disconnected"; version: number; secret_cipher: string | null; expires_at: number;
  refresh_claim: string | null; refresh_until: number | null;
}
export const googleSessionSql = `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.user_id=? AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND u.status='active')`;
export const googleSessionValues = (identity: Identity) => [identity.userId, identity.credentialId];
export const attemptContext = (id: string, userId: string, scope: GoogleScope = "normal") => ({ id, user_id: userId,
  provider_id: scope === "normal" ? "google" : "agent-google", purpose: scope === "normal" ? "ee-google-attempt-v1" : "ee-agent-google-attempt-v1" });
export const grantContext = (grant: Pick<GoogleGrant, "id" | "user_id" | "account_id" | "endpoint_hash" | "username" | "email_address" | "config_hash">, scope: GoogleScope = "normal") => ({
  id: grant.id, user_id: grant.user_id, provider_id: JSON.stringify([scope === "normal" ? "google" : "agent-google", grant.account_id, grant.endpoint_hash, grant.username, grant.email_address, grant.config_hash]),
  purpose: scope === "normal" ? "ee-google-grant-v1" : "ee-agent-google-grant-v1",
});
export async function attemptResult(env: Env, identity: Identity, row: GoogleAttempt, replayed: boolean, target: GoogleTarget = googleTargets.normal) {
  if (row.state === "failed") throw new HttpError(409, row.error_code ?? "google_oauth_restart_required");
  if (row.state !== "completed") throw new HttpError(409, "google_oauth_in_progress");
  const account = await target.account(env, identity.userId, row.account_id);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  return { account: target.view(account), authorizedRevision: row.result_revision, replayed };
}
