import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { credentialRequestHash, encryptCredential, sealVault } from "./mailbox-vault";
import { smtpEndpoint, type smtpConfigInput } from "./smtp-config-input";
import { agentAccount, agentAccountCredentialFence } from "./agent-account-store";
import { AGENT_SMTP_OPERATION_LIMIT, agentSmtpOperationView, type AgentSmtpConfig, type AgentSmtpOperation } from "./agent-smtp-model";
import { rateLimit } from "./rate-limits";

export const agentSmtpContext = (id: string, userId: string) => ({ id, user_id: userId, provider_id: "agent-smtp-v1", purpose: "ee-agent-smtp-v1" });
export const agentSmtpConfig = (env: Env, userId: string, id: string) => env.DB.prepare("SELECT * FROM agent_smtp_configs WHERE user_id=? AND account_id=?")
  .bind(userId, id).first<AgentSmtpConfig>();
export const agentSmtpOperation = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM agent_smtp_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<AgentSmtpOperation>();
export function completedAgentSmtpOperation(row: AgentSmtpOperation) {
  if (row.revision === null || row.completed_at === null) throw new HttpError(503, "agent_smtp_storage_failed");
  return agentSmtpOperationView(row);
}
export async function saveAgentSmtp(env: Env, identity: Identity, id: string, key: string, input: ReturnType<typeof smtpConfigInput>) {
  const context = agentSmtpContext(id, identity.userId), payload = JSON.stringify([id, input]);
  async function replay(row: AgentSmtpOperation) {
    if (await credentialRequestHash(env, context, payload, row.request_hash) !== row.request_hash) throw new HttpError(409, "idempotency_conflict");
    return { operation: completedAgentSmtpOperation(row), replayed: true };
  }
  const previous = await agentSmtpOperation(env, identity.userId, key); if (previous) return replay(previous);
  const account = await agentAccount(env, identity.userId, id);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  const current = await agentSmtpConfig(env, identity.userId, id);
  if (account.revision !== input.expectedRevision || (current?.revision ?? 0) !== input.revision) {
    const raced = await agentSmtpOperation(env, identity.userId, key); if (raced) return replay(raced);
    throw new HttpError(409, "agent_smtp_changed");
  }
  const endpoint = await smtpEndpoint(env, input.endpointId);
  const oauth = account.authentication === "google-oauth2";
  if (oauth !== (endpoint.authentication === "google-oauth2") || oauth && (input.password !== undefined || input.username !== account.email_address))
    throw new HttpError(400, "invalid_agent_smtp_request");
  await rateLimit(env, "agent-smtp-write", identity.userId, 10);
  const changed = current && (current.account_revision !== account.revision || current.endpoint_hash !== endpoint.hash || current.username !== input.username);
  let cipher = input.forgetCredential || changed ? null : current?.credential_cipher ?? null;
  if (input.password) cipher = await encryptCredential(env, context, { token: input.password });
  if (oauth && !input.forgetCredential) cipher = account.oauth_grant_id && account.credential_cipher
    ? await sealVault(env, context, { oauthGrantId: account.oauth_grant_id }) : null;
  if (input.enabled && (!account.enabled || !cipher)) throw new HttpError(409, "agent_smtp_credential_required");
  const digest = await credentialRequestHash(env, context, payload), opId = crypto.randomUUID(), now = unixNow(), revision = input.revision + 1;
  const fence = "EXISTS (SELECT 1 FROM agent_smtp_operations WHERE id=? AND completed_at IS NULL)";
  const reservation = env.DB.prepare(`INSERT INTO agent_smtp_operations(user_id,request_key,id,account_id,request_hash,account_revision,created_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM agent_accounts WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL)
    AND COALESCE((SELECT revision FROM agent_smtp_configs WHERE user_id=? AND account_id=?),0)=?
    AND ${agentAccountCredentialFence(identity)} AND (SELECT COUNT(*) FROM agent_smtp_operations WHERE user_id=?)<${AGENT_SMTP_OPERATION_LIMIT}
    ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(identity.userId, key, opId, id, digest, account.revision, now, identity.userId, id, account.revision,
      identity.userId, id, input.revision, identity.credentialId, identity.userId, identity.userId);
  const write = env.DB.prepare(`INSERT INTO agent_smtp_configs(account_id,user_id,account_revision,revision,endpoint_id,endpoint_hash,username,credential_cipher,enabled,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${fence} ON CONFLICT(account_id) DO UPDATE SET account_revision=excluded.account_revision,revision=excluded.revision,
      endpoint_id=excluded.endpoint_id,endpoint_hash=excluded.endpoint_hash,username=excluded.username,credential_cipher=excluded.credential_cipher,enabled=excluded.enabled,updated_at=excluded.updated_at`)
    .bind(id, identity.userId, account.revision, revision, input.endpointId, endpoint.hash, input.username, cipher, Number(input.enabled), now, opId);
  const complete = env.DB.prepare(`UPDATE agent_smtp_operations SET revision=(SELECT revision FROM agent_smtp_configs WHERE user_id=? AND account_id=?),completed_at=?
    WHERE id=? AND completed_at IS NULL`).bind(identity.userId, id, now, opId);
  let writes;
  try { writes = await env.DB.batch([reservation, write, complete]); } catch { throw new HttpError(503, "agent_smtp_storage_failed"); }
  const receipt = await agentSmtpOperation(env, identity.userId, key);
  if (!receipt) {
    const active = await env.DB.prepare(`SELECT 1 WHERE ${agentAccountCredentialFence(identity)}`).bind(identity.credentialId, identity.userId).first();
    if (!active) throw new HttpError(401, "unauthorized");
    throw new HttpError(409, "agent_smtp_changed_or_limit");
  }
  return writes[0].meta.changes ? { operation: completedAgentSmtpOperation(receipt), replayed: false } : replay(receipt);
}
