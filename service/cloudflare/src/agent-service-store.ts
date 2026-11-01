import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import type { AgentServiceCommand } from "./agent-service-input";
import { AGENT_SERVICE_LIMIT, AGENT_SERVICE_OPERATION_LIMIT, AGENT_SERVICE_SELECT, agentServiceOperationView, type AgentServiceOperation, type AgentServiceRow } from "./agent-service-model";

export const agentServiceRow = (env: Env, userId: string, id: string) => env.DB.prepare(`${AGENT_SERVICE_SELECT} WHERE user_id=? AND id=?`)
  .bind(userId, id).first<AgentServiceRow>();
export const agentServiceOperation = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM agent_service_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<AgentServiceOperation>();
export function completedAgentServiceOperation(row: AgentServiceOperation) {
  if (row.completed_at === null || !row.service_id || row.version === null) throw new HttpError(503, "agent_service_storage_failed");
  return agentServiceOperationView(row);
}

function writerFence(identity: Identity) {
  const table = identity.kind === "session" ? "sessions" : "api_keys", credential = identity.kind === "session" ? "token_hash" : "id";
  return `EXISTS (SELECT 1 FROM ${table} c JOIN users u ON u.id=c.user_id WHERE c.${credential}=? AND c.user_id=?
    AND c.revoked_at IS NULL AND c.expires_at>unixepoch() AND u.status='active')`;
}

async function reservationDenied(env: Env, identity: Identity, command: AgentServiceCommand): Promise<never> {
  if (!await env.DB.prepare(`SELECT 1 WHERE ${writerFence(identity)}`).bind(identity.credentialId, identity.userId).first()) throw new HttpError(401, "unauthorized");
  if (command.targetId) {
    const current = await agentServiceRow(env, identity.userId, command.targetId);
    if (!current || current.deleted_at !== null) throw new HttpError(404, "not_found");
    if (current.version !== command.expectedVersion) throw new HttpError(409, "agent_service_changed");
  } else if ((await env.DB.prepare("SELECT COUNT(*) n FROM agent_services WHERE user_id=?").bind(identity.userId).first<number>("n"))! >= AGENT_SERVICE_LIMIT) {
    throw new HttpError(409, "agent_service_limit");
  }
  if (command.fields.defaultSenderAccountId && !await env.DB.prepare("SELECT 1 FROM agent_accounts WHERE user_id=? AND id=? AND deleted_at IS NULL")
    .bind(identity.userId, command.fields.defaultSenderAccountId).first()) throw new HttpError(409, "agent_service_sender_unavailable");
  throw new HttpError(409, "agent_service_operation_limit");
}

export async function mutateAgentService(env: Env, identity: Identity, key: string, command: AgentServiceCommand) {
  const hash = await tokenHash(JSON.stringify(command));
  const replay = (row: AgentServiceOperation) => {
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
    return { operation: completedAgentServiceOperation(row), replayed: true };
  };
  const previous = await agentServiceOperation(env, identity.userId, key); if (previous) return replay(previous);
  const current = command.targetId ? await agentServiceRow(env, identity.userId, command.targetId) : null;
  if (command.targetId && (!current || current.deleted_at !== null || current.version !== command.expectedVersion)) {
    const raced = await agentServiceOperation(env, identity.userId, key); if (raced) return replay(raced);
    throw new HttpError(!current || current.deleted_at !== null ? 404 : 409, !current || current.deleted_at !== null ? "not_found" : "agent_service_changed");
  }
  const operationId = crypto.randomUUID(), serviceId = command.targetId ?? crypto.randomUUID(), now = unixNow();
  const fence = "EXISTS (SELECT 1 FROM agent_service_operations WHERE id=? AND completed_at IS NULL)";
  const target = command.kind === "POST" ? `(SELECT COUNT(*) FROM agent_services WHERE user_id=?) < ${AGENT_SERVICE_LIMIT}`
    : "EXISTS (SELECT 1 FROM agent_services WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL)";
  const senderId = command.fields.defaultSenderAccountId;
  const senderFence = senderId ? "AND EXISTS (SELECT 1 FROM agent_accounts WHERE user_id=? AND id=? AND deleted_at IS NULL)" : "";
  const statements = [env.DB.prepare(`INSERT INTO agent_service_operations(user_id,request_key,id,request_hash,kind,created_at)
    SELECT ?,?,?,?,?,? WHERE ${target} AND ${writerFence(identity)} ${senderFence}
    AND (SELECT COUNT(*) FROM agent_service_operations WHERE user_id=?) < ${AGENT_SERVICE_OPERATION_LIMIT}
    ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(identity.userId, key, operationId, hash, command.kind, now,
      ...(command.kind === "POST" ? [identity.userId] : [identity.userId, serviceId, command.expectedVersion!]), identity.credentialId, identity.userId,
      ...(senderId ? [identity.userId, senderId] : []), identity.userId)];
  const fields = command.fields;
  if (command.kind === "POST") {
    statements.push(env.DB.prepare(`INSERT INTO agent_services(user_id,id,display_name,email_address,description,service_kind,trust_level,status,version,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,1,?,? WHERE ${fence}`)
      .bind(identity.userId, serviceId, fields.displayName!, fields.emailAddress!, fields.description!, fields.serviceKind!, fields.trustLevel!, fields.status!, now, now, operationId));
  } else if (command.kind === "PATCH") {
    statements.push(env.DB.prepare(`UPDATE agent_services SET display_name=?,description=?,service_kind=?,trust_level=?,status=?,version=version+1,updated_at=?
      WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL AND ${fence}`)
      .bind(fields.displayName ?? current!.display_name, fields.description === undefined ? current!.description : fields.description,
        fields.serviceKind ?? current!.service_kind, fields.trustLevel ?? current!.trust_level, fields.status ?? current!.status, now,
        identity.userId, serviceId, command.expectedVersion!, operationId));
  } else {
    statements.push(env.DB.prepare(`UPDATE agent_services SET display_name='',email_address='',description=NULL,service_kind='email_agent',trust_level='blocked',status='archived',
      version=version+1,updated_at=?,deleted_at=? WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL AND ${fence}`)
      .bind(now, now, identity.userId, serviceId, command.expectedVersion!, operationId));
  }
  if (senderId !== undefined && command.kind !== "DELETE") {
    statements.push(env.DB.prepare(`DELETE FROM agent_service_senders WHERE user_id=? AND service_id=? AND ${fence}`).bind(identity.userId, serviceId, operationId));
    if (senderId) statements.push(env.DB.prepare(`INSERT INTO agent_service_senders(user_id,service_id,account_id) SELECT ?,?,? WHERE ${fence}`)
      .bind(identity.userId, serviceId, senderId, operationId));
  }
  statements.push(env.DB.prepare(`UPDATE agent_service_operations SET (service_id,version,deleted)=
    (SELECT id,version,deleted_at IS NOT NULL FROM agent_services WHERE user_id=? AND id=?),completed_at=? WHERE id=? AND completed_at IS NULL`)
    .bind(identity.userId, serviceId, now, operationId));
  let writes: D1Result[];
  try { writes = await env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("UNIQUE constraint failed: agent_services.user_id, agent_services.email_address")) throw new HttpError(409, "agent_service_email_unavailable");
    throw new HttpError(503, "agent_service_storage_failed");
  }
  const row = await agentServiceOperation(env, identity.userId, key);
  if (!row) return reservationDenied(env, identity, command);
  return writes[0].meta.changes ? { operation: completedAgentServiceOperation(row), replayed: false } : replay(row);
}
