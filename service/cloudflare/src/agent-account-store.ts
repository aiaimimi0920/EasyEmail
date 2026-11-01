import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { credentialRequestHash, encryptCredential } from "./mailbox-vault";
import { imapEndpoint } from "./normal-account-input";
import type { AgentAccountCommand } from "./agent-account-input";
import { AGENT_ACCOUNT_LIMIT, AGENT_ACCOUNT_ACTIVE_LIMIT, AGENT_ACCOUNT_OPERATION_LIMIT, agentAccountOperationView,
  type AgentAccount, type AgentAccountOperation } from "./agent-account-model";
import { rateLimit } from "./rate-limits";
import { agentAccountTable } from "./agent-account-authentication";
import { identityCredentialFence as agentAccountCredentialFence } from "./identity";
export { identityCredentialFence as agentAccountCredentialFence } from "./identity";

export const agentAccountContext = (id: string, userId: string) => ({ id, user_id: userId, provider_id: "agent-imap-v1", purpose: "ee-agent-account-v1" });
export const agentAccount = async (env: Env, userId: string, id: string) => {
  const row = await env.DB.prepare(`SELECT * FROM ${await agentAccountTable(env)} WHERE user_id=? AND id=?`).bind(userId, id).first<AgentAccount>();
  return row ? { ...row, authentication: row.authentication ?? "password", oauth_grant_id: row.oauth_grant_id ?? null, oauth_flow_id: row.oauth_flow_id ?? null } : null;
};
export const agentAccountOperation = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM agent_account_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<AgentAccountOperation>();
export function completedAgentAccountOperation(row: AgentAccountOperation) {
  if (row.completed_at === null || row.revision === null) throw new HttpError(503, "agent_account_storage_failed");
  return agentAccountOperationView(row);
}
export async function mutateAgentAccount(env: Env, identity: Identity, id: string, key: string, command: AgentAccountCommand) {
  const context = agentAccountContext(id, identity.userId), payload = JSON.stringify([id, command]);
  async function replay(row: AgentAccountOperation) {
    if (await credentialRequestHash(env, context, payload, row.request_hash) !== row.request_hash) throw new HttpError(409, "idempotency_conflict");
    return { operation: completedAgentAccountOperation(row), replayed: true };
  }
  const previous = await agentAccountOperation(env, identity.userId, key); if (previous) return replay(previous);
  const current = await agentAccount(env, identity.userId, id);
  if (current?.deleted_at != null || (current?.revision ?? 0) !== command.expectedRevision || (!current && command.deleting)) {
    const raced = await agentAccountOperation(env, identity.userId, key); if (raced) return replay(raced);
    throw new HttpError(current && current.deleted_at === null ? 409 : 404, current && current.deleted_at === null ? "agent_account_changed" : "not_found");
  }
  const fields = command.fields, endpoint = fields ? await imapEndpoint(env, fields.endpointId) : null;
  const authentication = endpoint?.authentication ?? (fields ? "password" : current!.authentication);
  if (fields && authentication === "google-oauth2" && (fields.password !== undefined || fields.username !== fields.emailAddress)) throw new HttpError(400, "invalid_agent_account_request");
  if (fields && current && fields.emailAddress !== current.email_address) throw new HttpError(409, "agent_account_address_immutable");
  if (fields && !current && !fields.password && authentication !== "google-oauth2") throw new HttpError(400, "agent_credential_required");
  await rateLimit(env, "agent-account-write", identity.userId, 10);
  let cipher = current?.credential_cipher ?? null;
  if (fields && current && (current.endpoint_hash !== endpoint!.hash || current.username !== fields.username)) cipher = null;
  if (command.deleting || fields?.forgetCredential) cipher = null;
  else if (fields?.password) cipher = await encryptCredential(env, context, { token: fields.password });
  if (fields?.enabled && !cipher) throw new HttpError(409, "agent_credential_required");
  const digest = await credentialRequestHash(env, context, payload), opId = crypto.randomUUID(), now = unixNow();
  const target = current ? "EXISTS (SELECT 1 FROM agent_accounts WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL)"
    : `NOT EXISTS (SELECT 1 FROM agent_accounts WHERE id=?) AND (SELECT COUNT(*) FROM agent_accounts WHERE user_id=?)<${AGENT_ACCOUNT_LIMIT}
      AND (SELECT COUNT(*) FROM agent_accounts WHERE user_id=? AND deleted_at IS NULL)<${AGENT_ACCOUNT_ACTIVE_LIMIT}`;
  const fence = "EXISTS (SELECT 1 FROM agent_account_operations WHERE id=? AND completed_at IS NULL)";
  const statements = [env.DB.prepare(`INSERT INTO agent_account_operations(user_id,request_key,id,account_id,request_hash,kind,deleted,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${target} AND ${agentAccountCredentialFence(identity)}
    AND (SELECT COUNT(*) FROM agent_account_operations WHERE user_id=?)<${AGENT_ACCOUNT_OPERATION_LIMIT}
    ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(identity.userId, key, opId, id, digest, command.deleting ? "DELETE" : "PUT", Number(command.deleting), now,
      ...(current ? [id, identity.userId, current.revision] : [id, identity.userId, identity.userId]), identity.credentialId, identity.userId, identity.userId)];
  if (!current) {
    statements.push(env.DB.prepare(`INSERT INTO agent_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,credential_cipher,enabled,revision,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,1,?,? WHERE ${fence}`)
      .bind(id, identity.userId, fields!.emailAddress, fields!.displayName, fields!.endpointId, endpoint!.hash, fields!.username, cipher,
        Number(fields!.enabled), now, now, opId));
  } else {
    statements.push(env.DB.prepare(`UPDATE agent_accounts SET email_address=?,display_name=?,endpoint_id=?,endpoint_hash=?,username=?,credential_cipher=?,
      enabled=?,revision=revision+1,updated_at=?,deleted_at=?,test_token=NULL,test_lease_until=NULL,tested_at=NULL,test_error=NULL,inbox_uid_validity=NULL,inbox_messages=NULL
      WHERE id=? AND user_id=? AND revision=? AND ${fence}`)
      .bind(fields?.emailAddress ?? "", fields?.displayName ?? "", fields?.endpointId ?? current.endpoint_id, endpoint?.hash ?? current.endpoint_hash,
        fields?.username ?? "", cipher, Number(fields?.enabled ?? false), now, command.deleting ? now : null, id, identity.userId, current.revision, opId));
  }
  if (authentication === "google-oauth2") statements.push(env.DB.prepare(`INSERT INTO agent_google_oauth_bindings(account_id,user_id,oauth_grant_id,oauth_flow_id)
    SELECT ?,?,?,NULL WHERE ${fence} ON CONFLICT(account_id) DO UPDATE SET oauth_grant_id=excluded.oauth_grant_id,oauth_flow_id=NULL`)
    .bind(id, identity.userId, cipher ? current?.oauth_grant_id ?? null : null, opId));
  else if (current?.authentication === "google-oauth2") statements.push(env.DB.prepare(`DELETE FROM agent_google_oauth_bindings WHERE account_id=? AND user_id=? AND ${fence}`)
    .bind(id, identity.userId, opId));
  statements.push(env.DB.prepare(`UPDATE agent_account_operations SET revision=(SELECT revision FROM agent_accounts WHERE id=? AND user_id=?),completed_at=?
    WHERE id=? AND completed_at IS NULL`).bind(id, identity.userId, now, opId));
  let writes: D1Result[];
  try { writes = await env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("UNIQUE constraint failed: agent_accounts.user_id")) throw new HttpError(409, "agent_address_unavailable");
    throw new HttpError(503, "agent_account_storage_failed");
  }
  const receipt = await agentAccountOperation(env, identity.userId, key);
  if (!receipt) {
    const active = await env.DB.prepare(`SELECT 1 WHERE ${agentAccountCredentialFence(identity)}`).bind(identity.credentialId, identity.userId).first();
    if (!active) throw new HttpError(401, "unauthorized");
    throw new HttpError(409, "agent_account_changed_or_limit");
  }
  return writes[0].meta.changes ? { operation: completedAgentAccountOperation(receipt), replayed: false } : replay(receipt);
}
