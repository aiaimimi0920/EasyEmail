import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { openVault, sealVault } from "./mailbox-vault";
import { imapEndpoint } from "./normal-account-input";
import { googleTargets, googleAccountStatements, type GoogleTarget } from "./google-oauth-target";
import { tokenHash } from "./security";
import { googleConfig } from "./google-oauth-config";
import { exchangeGoogleCode } from "./google-oauth-http";
import { attemptContext, attemptResult, grantContext, googleSessionSql, googleSessionValues, type GoogleAttempt } from "./google-oauth-model";

export async function completeGoogleOAuth(env: Env, identity: Identity, state: string, code?: string, denied = false, target: GoogleTarget = googleTargets.normal) {
  const stateHash = await tokenHash(state);
  const lookup = () => env.DB.prepare(`SELECT * FROM ${target.attempts} WHERE state_hash=? AND user_id=? AND session_hash=?`)
    .bind(stateHash, identity.userId, identity.credentialId).first<GoogleAttempt>();
  const row = await lookup(); if (!row) throw new HttpError(404, "not_found");
  if (row.state !== "pending") return attemptResult(env, identity, row, true, target);
  if (row.expires_at <= unixNow()) throw new HttpError(409, "google_oauth_expired");
  const claim = crypto.randomUUID();
  const acquired = await env.DB.prepare(`UPDATE ${target.attempts} SET state='exchanging',claim=?,exchange_until=unixepoch()+30
    WHERE id=? AND state='pending' AND expires_at>unixepoch() AND ${googleSessionSql}
    AND EXISTS (SELECT 1 FROM ${target.accounts} a WHERE a.id=${target.attempts}.account_id AND a.user_id=${target.attempts}.user_id
      AND a.revision=${target.attempts}.account_revision AND a.oauth_flow_id=${target.attempts}.id AND a.deleted_at IS NULL)`)
    .bind(claim, row.id, ...googleSessionValues(identity)).run();
  if (!acquired.meta.changes) return attemptResult(env, identity, (await lookup())!, true, target);
  try {
    if (denied || !code) throw new HttpError(409, "google_oauth_denied");
    const config = await googleConfig(env), account = await target.account(env, identity.userId, row.account_id);
    if (!account || account.deleted_at !== null || account.revision !== row.account_revision || account.oauth_flow_id !== row.id
      || account.authentication !== "google-oauth2" || row.config_hash !== config.hash) throw new HttpError(409, "google_oauth_account_mismatch");
    const endpoint = await imapEndpoint(env, account.endpoint_id);
    if (endpoint.authentication !== "google-oauth2" || endpoint.hash !== account.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");
    const secret = await openVault<{ verifier: string }>(env, attemptContext(row.id, identity.userId, target.scope), row.secret_cipher);
    const tokens = await exchangeGoogleCode(config, code, secret.verifier, account.email_address);
    const id = crypto.randomUUID(), now = unixNow(), grant = { id, user_id: identity.userId, account_id: account.id,
      endpoint_hash: endpoint.hash, username: account.username, email_address: account.email_address, config_hash: config.hash };
    const cipher = await sealVault(env, grantContext(grant, target.scope), tokens);
    const reference = await sealVault(env, target.context(account.id, identity.userId), { oauthGrantId: id });
    const installed = `EXISTS (SELECT 1 FROM ${target.grants} WHERE id=?)`;
    const writes = await env.DB.batch([
      env.DB.prepare(`INSERT INTO ${target.grants}(id,user_id,account_id,config_hash,endpoint_hash,username,email_address,state,version,secret_cipher,expires_at,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,'active',1,?,?,?,? WHERE ${googleSessionSql}
        AND EXISTS (SELECT 1 FROM ${target.attempts} WHERE id=? AND state='exchanging' AND claim=? AND exchange_until>unixepoch() AND expires_at>unixepoch())
        AND EXISTS (SELECT 1 FROM ${target.accounts} WHERE id=? AND user_id=? AND revision=? AND oauth_flow_id=? AND deleted_at IS NULL AND authentication='google-oauth2')`)
        .bind(id, identity.userId, account.id, config.hash, endpoint.hash, account.username, account.email_address, cipher, tokens.expiresAt, now, now,
          ...googleSessionValues(identity), row.id, claim, account.id, identity.userId, row.account_revision, row.id),
      ...googleAccountStatements(env, target, account, id, reference, now, installed, id),
      env.DB.prepare(`UPDATE ${target.grants} SET state='disconnected',secret_cipher=NULL,version=version+1,refresh_claim=NULL,refresh_until=NULL,updated_at=?
        WHERE user_id=? AND account_id=? AND id<>? AND ${installed}`).bind(now, identity.userId, account.id, id, id),
      env.DB.prepare(`UPDATE ${target.smtp} SET enabled=0,credential_cipher=NULL,revision=${target.scope === "agent" ? "MIN(revision+1,9007199254740991)" : "revision+1"},updated_at=? WHERE user_id=? AND account_id=? AND ${installed}`)
        .bind(now, identity.userId, account.id, id),
      env.DB.prepare(`UPDATE ${target.attempts} SET state='completed',secret_cipher=NULL,result_revision=?,error_code=NULL
        WHERE id=? AND state='exchanging' AND claim=? AND ${installed}`).bind(row.account_revision + 1, row.id, claim, id),
    ]);
    if (!writes[0].meta.changes) throw new HttpError(409, "google_oauth_account_changed");
    return attemptResult(env, identity, (await lookup())!, false, target);
  } catch (error) {
    // A DB acknowledgement may be lost after installation. Reconcile; never exchange the code again.
    const current = await lookup(); if (current?.state === "completed") return attemptResult(env, identity, current, true, target);
    const failure = error instanceof HttpError ? error : new HttpError(503, "google_oauth_storage_unknown");
    await env.DB.prepare(`UPDATE ${target.attempts} SET state='failed',secret_cipher=NULL,error_code=? WHERE id=? AND state='exchanging' AND claim=?`)
      .bind(failure.code, row.id, claim).run();
    throw failure;
  }
}
