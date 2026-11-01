import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { credentialRequestHash, openVault, sealVault } from "./mailbox-vault";
import { imapEndpoint } from "./normal-account-input";
import { googleTargets, googleFlowStatement, type GoogleTarget } from "./google-oauth-target";
import { rateLimit } from "./rate-limits";
import { tokenHash } from "./security";
import { googleAuthorizationUrl, googleConfig, randomOAuthValue } from "./google-oauth-config";
import { attemptContext, googleSessionSql, googleSessionValues, type GoogleAttempt } from "./google-oauth-model";

export async function startGoogleOAuth(env: Env, identity: Identity, accountId: string, revision: number, key: string, target: GoogleTarget = googleTargets.normal) {
  const context = attemptContext(accountId, identity.userId, target.scope), payload = JSON.stringify([accountId, revision]);
  const previous = () => env.DB.prepare(`SELECT * FROM ${target.attempts} WHERE user_id=? AND request_key=?`).bind(identity.userId, key).first<GoogleAttempt>();
  const config = await googleConfig(env);
  async function replay(row: GoogleAttempt) {
    if (row.session_hash !== identity.credentialId) throw new HttpError(404, "not_found");
    if (await credentialRequestHash(env, context, payload, row.request_hash) !== row.request_hash) throw new HttpError(409, "idempotency_conflict");
    const current = await target.account(env, identity.userId, accountId);
    if (row.state !== "pending" || row.expires_at <= unixNow() || row.config_hash !== config.hash
      || !current || current.oauth_flow_id !== row.id || current.revision !== revision || current.deleted_at !== null)
      throw new HttpError(409, "google_oauth_restart_required");
    const secret = await openVault<{ state: string; verifier: string }>(env, attemptContext(row.id, identity.userId, target.scope), row.secret_cipher);
    return { authorizationUrl: await googleAuthorizationUrl(config, secret.state, secret.verifier, current.email_address), expiresAt: row.expires_at, replayed: true };
  }
  const old = await previous(); if (old) return replay(old);
  const account = await target.account(env, identity.userId, accountId);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  if (account.revision !== revision) throw new HttpError(409, target.changed);
  const endpoint = await imapEndpoint(env, account.endpoint_id);
  if (account.authentication !== "google-oauth2" || endpoint.authentication !== "google-oauth2" || account.endpoint_hash !== endpoint.hash
    || account.username !== account.email_address) throw new HttpError(409, "google_oauth_account_mismatch");
  await rateLimit(env, "google-oauth-start", identity.userId, 5);
  const id = crypto.randomUUID(), state = randomOAuthValue(), verifier = randomOAuthValue(), now = unixNow(), expires = now + 600;
  const cipher = await sealVault(env, attemptContext(id, identity.userId, target.scope), { state, verifier });
  const digest = await credentialRequestHash(env, context, payload), stateHash = await tokenHash(state);
  const inserted = `EXISTS (SELECT 1 FROM ${target.attempts} WHERE id=? AND state='pending')`;
  const writes = await env.DB.batch([
    env.DB.prepare(`INSERT INTO ${target.attempts}(id,user_id,account_id,session_hash,request_key,request_hash,account_revision,config_hash,state_hash,secret_cipher,state,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE ${googleSessionSql}
      AND EXISTS (SELECT 1 FROM ${target.accounts} WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL AND authentication='google-oauth2')
      AND (SELECT COUNT(*) FROM ${target.attempts} WHERE user_id=?)<1000 ON CONFLICT(user_id,request_key) DO NOTHING`)
      .bind(id, identity.userId, accountId, identity.credentialId, key, digest, revision, config.hash, stateHash, cipher, now, expires,
        ...googleSessionValues(identity), accountId, identity.userId, revision, identity.userId),
    googleFlowStatement(env, target, accountId, identity.userId, id, inserted),
    env.DB.prepare(`UPDATE ${target.attempts} SET state='failed',error_code='google_oauth_superseded',secret_cipher=NULL
      WHERE user_id=? AND account_id=? AND id<>? AND state IN ('pending','exchanging') AND ${inserted}`).bind(identity.userId, accountId, id, id),
  ]);
  if (!writes[0].meta.changes) { const raced = await previous(); if (raced) return replay(raced); throw new HttpError(409, "google_oauth_account_changed_or_limit"); }
  return { authorizationUrl: await googleAuthorizationUrl(config, state, verifier, account.email_address), expiresAt: expires, replayed: false };
}
