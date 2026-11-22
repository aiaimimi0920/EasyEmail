import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import { agentAccountCredentialFence } from "./agent-account-store";
import { AGENT_THREAD_COLUMNS, agentThreadOperationView, type AgentThreadInput, type AgentThreadRow, type AgentThreadOperation } from "./agent-thread-model";
import { AGENT_INBOUND_THREAD_SELECT, type AgentInboundThreadRow } from "./agent-inbound-model";

export async function assertAgentThreadCredential(env: Env, identity: Identity) {
  if (!await env.DB.prepare(`SELECT 1 WHERE ${agentAccountCredentialFence(identity)}`).bind(identity.credentialId, identity.userId).first()) throw new HttpError(401, "unauthorized");
}
export async function ownedAgentThread(env: Env, userId: string, id: string) {
  const row = await env.DB.prepare(`${AGENT_THREAD_COLUMNS} WHERE t.user_id=? AND t.id=?`).bind(userId, id).first<AgentThreadRow>();
  if (row) return row;
  const inbound = await env.DB.prepare(`${AGENT_INBOUND_THREAD_SELECT} WHERE i.user_id=? AND i.id=?`).bind(userId, id).first<AgentInboundThreadRow>();
  if (!inbound) throw new HttpError(404, "not_found"); return inbound;
}
async function operationByKey(env: Env, userId: string, key: string) {
  return await env.DB.prepare("SELECT * FROM agent_thread_operations WHERE user_id=? AND request_key=?").bind(userId, key).first<AgentThreadOperation>()
    ?? await env.DB.prepare("SELECT * FROM agent_inbound_state_operations WHERE user_id=? AND request_key=?").bind(userId, key).first<AgentThreadOperation>();
}
async function completed(env: Env, identity: Identity, row: AgentThreadOperation) {
  await assertAgentThreadCredential(env, identity);
  if (row.revision === null || row.completed_at === null) throw new HttpError(503, "agent_thread_storage_failed");
  return agentThreadOperationView(row);
}
export async function getAgentThreadOperation(env: Env, identity: Identity, key: string) {
  const row = await operationByKey(env, identity.userId, key);
  if (!row) throw new HttpError(404, "not_found"); return completed(env, identity, row);
}
export async function mutateAgentThread(env: Env, identity: Identity, threadId: string, key: string, input: AgentThreadInput) {
  const hash = await tokenHash(JSON.stringify({ threadId, ...input }));
  const replay = async (row: AgentThreadOperation) => {
    const operation = await completed(env, identity, row);
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict"); return { operation, replayed: true };
  };
  const previous = await operationByKey(env, identity.userId, key); if (previous) return replay(previous);
  const current = await ownedAgentThread(env, identity.userId, threadId);
  const inbound = "seed_message_id" in current;
  if ((inbound ? current.revision : current.management_revision ?? 0) !== input.expectedRevision) {
    const raced = await operationByKey(env, identity.userId, key); if (raced) return replay(raced);
    throw new HttpError(409, "agent_thread_changed");
  }
  const table = inbound ? "agent_inbound_state_operations" : "agent_thread_operations", root = inbound ? "agent_inbound_threads" : "agent_threads";
  const revision = inbound ? "(SELECT revision FROM agent_inbound_threads WHERE user_id=? AND id=?)" : "COALESCE((SELECT revision FROM agent_thread_management WHERE user_id=? AND thread_id=?),0)";
  const id = crypto.randomUUID(), now = unixNow(), fence = `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND completed_at IS NULL)`;
  let failed = false;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO ${table}(id,user_id,thread_id,request_key,request_hash,state,created_at)
        SELECT ?,?,?,?,?,?,? WHERE ${agentAccountCredentialFence(identity)}
        AND EXISTS(SELECT 1 FROM ${root} WHERE user_id=? AND id=?) AND ${revision}=?
        AND (SELECT COUNT(*) FROM agent_thread_operation_history WHERE user_id=?)<10000 ON CONFLICT(user_id,request_key) DO NOTHING`)
        .bind(id, identity.userId, threadId, key, hash, input.state, now, identity.credentialId, identity.userId,
          identity.userId, threadId, identity.userId, threadId, input.expectedRevision, identity.userId),
      inbound ? env.DB.prepare(`UPDATE agent_inbound_threads SET state=?,revision=?,updated_at=? WHERE user_id=? AND id=? AND ${fence}`)
        .bind(input.state, input.expectedRevision + 1, now, identity.userId, threadId, id)
      : env.DB.prepare(`INSERT INTO agent_thread_management(user_id,thread_id,state,revision,updated_at)
        SELECT ?,?,?,?,? WHERE ${fence} ON CONFLICT(user_id,thread_id)
        DO UPDATE SET state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at`)
        .bind(identity.userId, threadId, input.state, input.expectedRevision + 1, now, id),
      env.DB.prepare(`UPDATE ${table} SET revision=?,completed_at=? WHERE id=? AND completed_at IS NULL`)
        .bind(input.expectedRevision + 1, now, id),
    ]);
  } catch { failed = true; }
  const result = await operationByKey(env, identity.userId, key);
  if (failed && result?.id === id) throw new HttpError(503, "agent_thread_storage_failed");
  if (result) return result.id === id ? { operation: await completed(env, identity, result), replayed: false } : replay(result);
  await assertAgentThreadCredential(env, identity); await ownedAgentThread(env, identity.userId, threadId);
  if (failed) throw new HttpError(503, "agent_thread_storage_failed");
  const count = await env.DB.prepare("SELECT COUNT(*) n FROM agent_thread_operation_history WHERE user_id=?").bind(identity.userId).first<number>("n");
  throw new HttpError(409, count !== null && count >= 10000 ? "agent_thread_operation_limit" : "agent_thread_changed");
}
