import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { credentialRequestHash, encryptCredential, sealVault } from "./mailbox-vault";
import { normalAccount } from "./normal-account-store";
import { smtpEndpoint, type smtpConfigInput } from "./smtp-config-input";
import { rateLimit } from "./rate-limits";

export interface SmtpConfig {
  account_id: string; user_id: string; account_revision: number; revision: number; endpoint_id: string; endpoint_hash: string;
  username: string; credential_cipher: string | null; enabled: number; updated_at: number;
}
interface SmtpOperation { id: string; account_id: string; request_hash: string; revision: number }
export const smtpContext = (id: string, userId: string) => ({ id, user_id: userId, provider_id: "normal-smtp-v1", purpose: "ee-normal-smtp-v1" });
export const smtpConfig = (env: Env, userId: string, id: string) => env.DB.prepare("SELECT * FROM normal_smtp_configs WHERE user_id=? AND account_id=?").bind(userId, id).first<SmtpConfig>();
export function smtpView(row: SmtpConfig | null, accountRevision: number) {
  return row ? { revision: row.revision, accountRevision: row.account_revision, endpointId: row.endpoint_id, username: row.username,
    credentialConfigured: !!row.credential_cipher, enabled: row.enabled === 1, current: row.account_revision === accountRevision, updatedAt: row.updated_at }
    : { revision: 0, accountRevision, endpointId: "", username: "", credentialConfigured: false, enabled: false, current: false, updatedAt: null };
}
export async function saveSmtpConfig(env: Env, identity: Identity, id: string, key: string, input: ReturnType<typeof smtpConfigInput>) {
  const context = smtpContext(id, identity.userId), payload = JSON.stringify([id, input]);
  const operation = () => env.DB.prepare("SELECT * FROM normal_smtp_operations WHERE user_id=? AND request_key=?").bind(identity.userId, key).first<SmtpOperation>();
  async function result(op: SmtpOperation, replayed: boolean) {
    if (await credentialRequestHash(env, context, payload, op.request_hash) !== op.request_hash) throw new HttpError(409, "idempotency_conflict");
    const account = await normalAccount(env, identity.userId, id);
    return { smtp: smtpView(await smtpConfig(env, identity.userId, id), account?.revision ?? 0), operation: { id: op.id, accountId: op.account_id, revision: op.revision }, replayed };
  }
  const previous = await operation(); if (previous) return result(previous, true);
  const account = await normalAccount(env, identity.userId, id);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  const current = await smtpConfig(env, identity.userId, id);
  if (account.revision !== input.expectedRevision || (current?.revision ?? 0) !== input.revision) {
    const raced = await operation(); if (raced) return result(raced, true);
    throw new HttpError(409, "smtp_config_changed");
  }
  await rateLimit(env, "smtp-config-write", identity.userId, 10);
  const endpoint = await smtpEndpoint(env, input.endpointId);
  const oauth = account.authentication === "google-oauth2";
  if (oauth !== (endpoint.authentication === "google-oauth2") || (oauth && (input.password !== undefined || input.username !== account.email_address)))
    throw new HttpError(400, "invalid_smtp_request");
  // Never carry a password silently to a different server, login identity or account version.
  const changedIdentity = current && (current.endpoint_hash !== endpoint.hash || current.username !== input.username || current.account_revision !== account.revision);
  let cipher = input.forgetCredential || changedIdentity ? null : current?.credential_cipher ?? null;
  if (input.password) cipher = await encryptCredential(env, context, { token: input.password });
  if (oauth && !input.forgetCredential) cipher = account.oauth_grant_id && account.credential_cipher
    ? await sealVault(env, context, { oauthGrantId: account.oauth_grant_id }) : null;
  if (input.enabled && (!account.enabled || !cipher)) throw new HttpError(409, "smtp_credential_required");
  const digest = await credentialRequestHash(env, context, payload), opId = crypto.randomUUID(), now = unixNow(), revision = input.revision + 1;
  const fence = "EXISTS (SELECT 1 FROM normal_smtp_operations WHERE id=?)";
  const reservation = env.DB.prepare(`INSERT INTO normal_smtp_operations(user_id,request_key,id,account_id,request_hash,revision,created_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
      AND EXISTS (SELECT 1 FROM normal_accounts WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL)
      AND COALESCE((SELECT revision FROM normal_smtp_configs WHERE user_id=? AND account_id=?),0)=?
      AND (SELECT COUNT(*) FROM normal_smtp_operations WHERE user_id=?)<10000 ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(identity.userId, key, opId, id, digest, revision, now, identity.userId, identity.userId, id, input.expectedRevision, identity.userId, id, input.revision, identity.userId);
  const write = env.DB.prepare(`INSERT INTO normal_smtp_configs(account_id,user_id,account_revision,revision,endpoint_id,endpoint_hash,username,credential_cipher,enabled,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${fence} ON CONFLICT(account_id) DO UPDATE SET account_revision=excluded.account_revision,revision=excluded.revision,
      endpoint_id=excluded.endpoint_id,endpoint_hash=excluded.endpoint_hash,username=excluded.username,credential_cipher=excluded.credential_cipher,enabled=excluded.enabled,updated_at=excluded.updated_at`)
    .bind(id, identity.userId, account.revision, revision, input.endpointId, endpoint.hash, input.username, cipher, Number(input.enabled), now, opId);
  let writes;
  try { writes = await env.DB.batch([reservation, write]); } catch { throw new HttpError(503, "smtp_config_storage_failed"); }
  const receipt = await operation(); if (!receipt) throw new HttpError(409, "smtp_config_changed_or_limit");
  return result(receipt, !writes[0].meta.changes);
}
