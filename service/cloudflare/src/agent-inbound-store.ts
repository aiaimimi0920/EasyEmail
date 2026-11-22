import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import { agentAccountCredentialFence } from "./agent-account-store";
import { agentInboxContext, agentIncomingMessage } from "./agent-inbox-access";
import { assertAgentThreadCredential } from "./agent-thread-store";
import { agentInboundOperationView, type AgentInboundInput, type AgentInboundOperation } from "./agent-inbound-model";

const operationByKey = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM agent_inbound_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<AgentInboundOperation>();
async function completed(env: Env, identity: Identity, row: AgentInboundOperation) {
  await assertAgentThreadCredential(env, identity);
  if (row.completed_at === null) throw new HttpError(503, "agent_inbound_storage_failed");
  return agentInboundOperationView(row);
}
export async function getAgentInboundOperation(env: Env, identity: Identity, accountId: string, key: string) {
  const row = await operationByKey(env, identity.userId, key);
  if (!row || row.account_id !== accountId) throw new HttpError(404, "not_found"); return completed(env, identity, row);
}
export async function createAgentInbound(env: Env, identity: Identity, accountId: string, messageId: string, key: string, input: AgentInboundInput) {
  const hash = await tokenHash(JSON.stringify({ accountId, messageId, ...input }));
  const replay = async (row: AgentInboundOperation) => {
    const operation = await completed(env, identity, row);
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict"); return { operation, replayed: true };
  };
  const previous = await operationByKey(env, identity.userId, key); if (previous) return replay(previous);
  const context = await agentInboxContext(env, identity, accountId), message = await agentIncomingMessage(env, context, messageId);
  if (context.account.revision !== input.accountRevision || context.epochId !== input.epochId) throw new HttpError(409, "agent_inbox_changed");
  const effectiveTask = message.review_state === "linked" ? message.review_thread_id : message.review_state === null ? message.thread_id : null;
  if ((message.review_revision ?? 0) !== input.expectedRevision || effectiveTask) throw new HttpError(409, "agent_inbound_source_changed");
  const id = crypto.randomUUID(), threadId = crypto.randomUUID(), now = unixNow();
  const reserved = "EXISTS(SELECT 1 FROM agent_inbound_operations WHERE id=? AND completed_at IS NULL)";
  let failed = false;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO agent_inbound_operations(id,user_id,account_id,message_id,request_key,request_hash,thread_id,
        account_revision,epoch_id,review_revision,service_id,service_version,confirm_restricted,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${agentAccountCredentialFence(identity)}
        AND EXISTS(SELECT 1 FROM agent_accounts WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM agent_inbox_state WHERE user_id=? AND account_id=? AND epoch_id=? AND cache_generation=?)
        AND EXISTS(SELECT 1 FROM agent_incoming_messages m JOIN agent_inbox_batches b ON b.id=m.batch_id
          LEFT JOIN agent_incoming_reviews r ON r.user_id=m.user_id AND r.account_id=m.account_id AND r.message_id=m.id
          WHERE m.user_id=? AND m.account_id=? AND m.id=? AND m.epoch_id=? AND m.purged_at IS NULL AND b.state='committed'
          AND COALESCE(r.revision,0)=? AND (CASE WHEN r.state='linked' THEN r.thread_id WHEN r.state IS NULL THEN m.thread_id ELSE NULL END) IS NULL)
        AND EXISTS(SELECT 1 FROM agent_services WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL AND status='active'
          AND trust_level<>'blocked' AND (trust_level<>'restricted' OR ?=1))
        AND NOT EXISTS(SELECT 1 FROM agent_inbound_threads WHERE user_id=? AND account_id=? AND seed_message_id=?)
        AND (SELECT COUNT(*) FROM agent_inbound_operations WHERE user_id=?)<10000
        AND (SELECT COUNT(*) FROM agent_inbound_threads WHERE user_id=?)<10000 ON CONFLICT(user_id,request_key) DO NOTHING`)
        .bind(id, identity.userId, accountId, messageId, key, hash, threadId, input.accountRevision, input.epochId, input.expectedRevision,
          input.serviceId, input.serviceVersion, Number(input.confirmRestricted), now, identity.credentialId, identity.userId, identity.userId, accountId, input.accountRevision,
          identity.userId, accountId, input.epochId, context.generation, identity.userId, accountId, messageId, input.epochId, input.expectedRevision,
          identity.userId, input.serviceId, input.serviceVersion, Number(input.confirmRestricted), identity.userId, accountId, messageId, identity.userId, identity.userId),
      env.DB.prepare(`INSERT INTO agent_inbound_threads(id,user_id,account_id,account_revision,epoch_id,seed_message_id,service_id,service_version,state,revision,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,'needs_attention',1,?,? WHERE ${reserved}`)
        .bind(threadId, identity.userId, accountId, input.accountRevision, input.epochId, messageId, input.serviceId, input.serviceVersion, now, now, id),
      env.DB.prepare(`INSERT INTO agent_inbound_messages(user_id,thread_id,account_id,message_id,review_revision,created_at) SELECT ?,?,?,?,?,? WHERE ${reserved}`)
        .bind(identity.userId, threadId, accountId, messageId, input.expectedRevision, now, id),
      env.DB.prepare("UPDATE agent_inbound_operations SET completed_at=? WHERE id=? AND completed_at IS NULL").bind(now, id),
    ]);
  } catch { failed = true; }
  // A lost ACK is reconciled by the original key, never by creating another root.
  const result = await operationByKey(env, identity.userId, key);
  if (failed && result?.id === id) throw new HttpError(503, "agent_inbound_storage_failed");
  if (result) return result.id === id ? { operation: await completed(env, identity, result), replayed: false } : replay(result);
  await assertAgentThreadCredential(env, identity);
  if (failed) throw new HttpError(503, "agent_inbound_storage_failed");
  throw new HttpError(409, "agent_inbound_source_service_changed_or_limit");
}
