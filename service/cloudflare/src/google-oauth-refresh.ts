import { unixNow, type Env } from "./contracts";
import { HttpError } from "./http";
import { openVault, sealVault } from "./mailbox-vault";
import { googleTargets, type GoogleAccount, type GoogleTarget } from "./google-oauth-target";
import { googleConfig } from "./google-oauth-config";
import { refreshGoogleTokens, type GoogleTokens } from "./google-oauth-http";
import { grantContext, type GoogleGrant } from "./google-oauth-model";

const accountValues = (account: GoogleAccount, grantId: string) => [account.id, account.user_id, account.revision, grantId];
export async function googleAuthentication(env: Env, account: GoogleAccount, grantId: string, target: GoogleTarget = googleTargets.normal) {
  const accountSql = `EXISTS (SELECT 1 FROM ${target.accounts} a JOIN users u ON u.id=a.user_id
    WHERE a.id=? AND a.user_id=? AND a.revision=? AND a.enabled=1 AND a.deleted_at IS NULL AND a.oauth_grant_id=? AND u.status='active')`;
  const lookup = () => env.DB.prepare(`SELECT * FROM ${target.grants} WHERE id=? AND user_id=? AND account_id=?`)
    .bind(grantId, account.user_id, account.id).first<GoogleGrant>();
  let grant = await lookup();
  const config = await googleConfig(env);
  if (!grant || account.authentication !== "google-oauth2" || account.oauth_grant_id !== grantId || grant.state !== "active"
    || grant.config_hash !== config.hash || grant.endpoint_hash !== account.endpoint_hash || grant.username !== account.username
    || grant.email_address !== account.email_address) throw new HttpError(409, "google_oauth_reauthorization_required");
  if (grant.refresh_claim) {
    if ((grant.refresh_until ?? 0) <= unixNow()) {
      await env.DB.prepare(`UPDATE ${target.grants} SET state='reauthorize',secret_cipher=NULL,version=version+1,refresh_claim=NULL,refresh_until=NULL
        WHERE id=? AND version=? AND refresh_claim=? AND refresh_until<=unixepoch()`)
        .bind(grant.id, grant.version, grant.refresh_claim).run();
      throw new HttpError(409, "google_oauth_reauthorization_required");
    }
    throw new HttpError(409, "google_oauth_refresh_busy");
  }
  let tokens = await openVault<GoogleTokens>(env, grantContext(grant, target.scope), grant.secret_cipher);
  if (tokens.expiresAt !== grant.expires_at || !tokens.refreshToken || !tokens.subject) throw new HttpError(503, "mailbox_credential_unavailable");
  if (tokens.expiresAt <= unixNow() + 90) {
    if (tokens.refreshExpiresAt !== undefined && tokens.refreshExpiresAt <= unixNow()) {
      await env.DB.prepare(`UPDATE ${target.grants} SET state='reauthorize',secret_cipher=NULL,version=version+1,updated_at=?
        WHERE id=? AND version=? AND state='active' AND refresh_claim IS NULL`).bind(unixNow(), grant.id, grant.version).run();
      throw new HttpError(409, "google_oauth_reauthorization_required");
    }
    const claim = crypto.randomUUID(), version = grant.version;
    const acquired = await env.DB.prepare(`UPDATE ${target.grants} SET refresh_claim=?,refresh_until=unixepoch()+30
      WHERE id=? AND version=? AND state='active' AND refresh_claim IS NULL AND ${accountSql}`)
      .bind(claim, grant.id, version, ...accountValues(account, grantId)).run();
    if (!acquired.meta.changes) throw new HttpError(409, "google_oauth_refresh_busy_or_changed");
    try {
      const refreshed = await refreshGoogleTokens(config, tokens), cipher = await sealVault(env, grantContext(grant, target.scope), refreshed);
      const written = await env.DB.prepare(`UPDATE ${target.grants} SET secret_cipher=?,expires_at=?,version=version+1,refresh_claim=NULL,refresh_until=NULL,updated_at=?
        WHERE id=? AND version=? AND state='active' AND refresh_claim=? AND refresh_until>unixepoch() AND ${accountSql}`)
        .bind(cipher, refreshed.expiresAt, unixNow(), grant.id, version, claim, ...accountValues(account, grantId)).run();
      if (!written.meta.changes) throw new HttpError(409, "google_oauth_account_changed");
      tokens = refreshed; grant = { ...grant, version: version + 1, expires_at: refreshed.expiresAt };
    } catch (error) {
      // Never reopen an uncertain refresh claim. A rotated token may already exist remotely.
      await env.DB.prepare(`UPDATE ${target.grants} SET state='reauthorize',secret_cipher=NULL,version=version+1,refresh_claim=NULL,refresh_until=NULL,updated_at=?
        WHERE id=? AND version=? AND state='active' AND refresh_claim=?`).bind(unixNow(), grant.id, version, claim).run();
      throw error instanceof HttpError ? error : new HttpError(503, "google_oauth_storage_unknown");
    }
  }
  const fence = { sql: `EXISTS (SELECT 1 FROM ${target.grants} WHERE id=? AND user_id=? AND account_id=? AND version=?
    AND state='active' AND refresh_claim IS NULL AND expires_at>unixepoch()+15)`, values: [grant.id, account.user_id, account.id, grant.version] };
  const usable = await env.DB.prepare(`SELECT 1 ok WHERE ${fence.sql} AND ${accountSql}`)
    .bind(...fence.values, ...accountValues(account, grantId)).first();
  if (!usable) throw new HttpError(409, "google_oauth_account_changed");
  return { authentication: { method: "xoauth2" as const, accessToken: tokens.accessToken }, fence };
}
