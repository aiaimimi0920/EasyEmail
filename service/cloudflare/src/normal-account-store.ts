import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { credentialRequestHash, encryptCredential } from "./mailbox-vault";
import { imapEndpoint, type NormalAccountCommand } from "./normal-account-input";
import { normalAccountView, type NormalAccount, type NormalOperation } from "./normal-account-model";
import { rateLimit } from "./rate-limits";

export const normalContext = (id: string, userId: string) => ({ id, user_id: userId, provider_id: "normal-imap-v1", purpose: "ee-normal-account-v1" });
export const normalAccount = (env: Env, userId: string, id: string) => env.DB.prepare("SELECT * FROM normal_accounts WHERE user_id=? AND id=?")
  .bind(userId, id).first<NormalAccount>();
const operation = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM normal_account_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<NormalOperation>();

export async function mutateNormalAccount(env: Env, identity: Identity, id: string, key: string, command: NormalAccountCommand) {
  const context = normalContext(id, identity.userId), payload = JSON.stringify([id, command]);
  async function result(row: NormalOperation, replayed: boolean) {
    if (await credentialRequestHash(env, context, payload, row.request_hash) !== row.request_hash) throw new HttpError(409, "idempotency_conflict");
    if (row.completed_at === null || row.revision === null) throw new HttpError(503, "normal_account_storage_failed");
    const account = await normalAccount(env, identity.userId, row.account_id);
    if (!account) throw new HttpError(503, "normal_account_storage_failed");
    return { account: normalAccountView(account), operation: { id: row.id, accountId: row.account_id, revision: row.revision, deleted: row.deleted === 1 }, replayed };
  }
  const previous = await operation(env, identity.userId, key); if (previous) return result(previous, true);
  const current = await normalAccount(env, identity.userId, id);
  if (current?.deleted_at !== null && current?.deleted_at !== undefined) throw new HttpError(404, "not_found");
  if ((current?.revision ?? 0) !== command.expectedRevision || (!current && command.deleting)) {
    const raced = await operation(env, identity.userId, key); if (raced) return result(raced, true);
    throw new HttpError(current ? 409 : 404, current ? "normal_account_changed" : "not_found");
  }
  await rateLimit(env, "normal-account-write", identity.userId, 10);
  const fields = command.fields, endpoint = fields ? await imapEndpoint(env, fields.endpointId) : null;
  const authentication = endpoint?.authentication ?? (fields ? "password" : current!.authentication);
  if (fields && authentication === "google-oauth2" && (fields.password !== undefined || fields.username !== fields.emailAddress)) throw new HttpError(400, "invalid_normal_account_request");
  if (fields && !current && !fields.password && authentication !== "google-oauth2") throw new HttpError(400, "normal_credential_required");
  let cipher = current?.credential_cipher ?? null;
  const changedIdentity = fields && current && (current.endpoint_hash !== endpoint!.hash || current.username !== fields.username
    || (current.authentication === "google-oauth2" && current.email_address !== fields.emailAddress));
  if (changedIdentity) cipher = null;
  if (command.deleting || fields?.forgetCredential) cipher = null;
  else if (fields?.password) cipher = await encryptCredential(env, context, { token: fields.password });
  if (fields?.enabled && !cipher) throw new HttpError(409, "normal_credential_required");
  const digest = await credentialRequestHash(env, context, payload), opId = crypto.randomUUID(), now = unixNow();
  const active = "EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')";
  const target = current ? "EXISTS (SELECT 1 FROM normal_accounts WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL)"
    : "NOT EXISTS (SELECT 1 FROM normal_accounts WHERE id=?) AND (SELECT COUNT(*) FROM normal_accounts WHERE user_id=?)<100 AND (SELECT COUNT(*) FROM normal_accounts WHERE user_id=? AND deleted_at IS NULL)<20";
  const fence = "EXISTS (SELECT 1 FROM normal_account_operations WHERE id=? AND completed_at IS NULL)";
  const statements = [env.DB.prepare(`INSERT INTO normal_account_operations(user_id,request_key,id,account_id,request_hash,deleted,created_at)
    SELECT ?,?,?,?,?,?,? WHERE ${active} AND ${target} ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(identity.userId, key, opId, id, digest, Number(command.deleting), now, identity.userId,
      ...(current ? [id, identity.userId, current.revision] : [id, identity.userId, identity.userId]))];
  if (!current) {
    statements.push(env.DB.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,credential_cipher,enabled,revision,created_at,updated_at,authentication)
      SELECT ?,?,?,?,?,?,?,?,?,1,?,?,? WHERE ${fence}`)
      .bind(id, identity.userId, fields!.emailAddress, fields!.displayName, fields!.endpointId, endpoint!.hash, fields!.username, cipher,
        Number(fields!.enabled), now, now, authentication, opId));
  } else {
    statements.push(env.DB.prepare(`UPDATE normal_accounts SET email_address=?,display_name=?,endpoint_id=?,endpoint_hash=?,username=?,credential_cipher=?,
      enabled=?,revision=revision+1,updated_at=?,deleted_at=?,test_token=NULL,test_lease_until=NULL,tested_at=NULL,test_error=NULL,inbox_uid_validity=NULL,inbox_messages=NULL,
      authentication=?,oauth_grant_id=?,oauth_flow_id=NULL
      WHERE id=? AND user_id=? AND revision=? AND ${fence}`)
      .bind(fields?.emailAddress ?? "", fields?.displayName ?? "", fields?.endpointId ?? current.endpoint_id, endpoint?.hash ?? current.endpoint_hash,
        fields?.username ?? "", cipher, Number(fields?.enabled ?? false), now, command.deleting ? now : null, authentication,
        cipher && authentication === "google-oauth2" ? current.oauth_grant_id : null, id, identity.userId, current.revision, opId));
  }
  if (current && (command.deleting || fields?.forgetCredential || changedIdentity)) statements.push(env.DB.prepare(`UPDATE google_oauth_grants SET state='disconnected',secret_cipher=NULL,
    version=version+1,refresh_claim=NULL,refresh_until=NULL,updated_at=? WHERE user_id=? AND account_id=? AND ${fence}`).bind(now, identity.userId, id, opId));
  if (current && (command.deleting || fields?.forgetCredential)) statements.push(env.DB.prepare(`UPDATE normal_smtp_configs SET credential_cipher=NULL,enabled=0,revision=revision+1,updated_at=?
    WHERE user_id=? AND account_id=? AND ${fence}`).bind(now, identity.userId, id, opId));
  statements.push(env.DB.prepare(`UPDATE normal_account_operations SET revision=(SELECT revision FROM normal_accounts WHERE id=? AND user_id=?),completed_at=? WHERE id=? AND completed_at IS NULL`)
    .bind(id, identity.userId, now, opId));
  let writes;
  try { writes = await env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("UNIQUE constraint failed: normal_accounts.user_id")) throw new HttpError(409, "normal_address_unavailable");
    throw new HttpError(503, "normal_account_storage_failed");
  }
  const receipt = await operation(env, identity.userId, key);
  if (!receipt) throw new HttpError(409, "normal_account_changed_or_limit");
  return result(receipt, !writes[0].meta.changes);
}
