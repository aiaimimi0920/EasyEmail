import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import { agentAccountCredentialFence } from "./agent-account-store";
import { agentInboxContext, agentIncomingMessage } from "./agent-inbox-access";
import { agentReviewOperationView, type AgentReviewOperation } from "./agent-review-model";
import type { AgentReviewInput } from "./agent-review-input";

export const agentReviewOperation = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM agent_review_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<AgentReviewOperation>();
async function completed(env: Env, identity: Identity, row: AgentReviewOperation) {
  if (!await env.DB.prepare(`SELECT 1 WHERE ${agentAccountCredentialFence(identity)}`).bind(identity.credentialId, identity.userId).first()) throw new HttpError(401, "unauthorized");
  if (row.revision === null || row.completed_at === null) throw new HttpError(503, "agent_review_storage_failed");
  return agentReviewOperationView(row);
}
export async function getAgentReviewOperation(env: Env, identity: Identity, accountId: string, key: string) {
  const row = await agentReviewOperation(env, identity.userId, key);
  if (!row || row.account_id !== accountId) throw new HttpError(404, "not_found"); return completed(env, identity, row);
}
export async function mutateAgentReview(env: Env, identity: Identity, accountId: string, messageId: string, key: string, input: AgentReviewInput) {
  const hash = await tokenHash(JSON.stringify({ accountId, messageId, ...input }));
  const replay = async (row: AgentReviewOperation) => {
    const operation = await completed(env, identity, row);
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict"); return { operation, replayed: true };
  };
  const previous = await agentReviewOperation(env, identity.userId, key); if (previous) return replay(previous);
  const context = await agentInboxContext(env, identity, accountId), row = await agentIncomingMessage(env, context, messageId);
  if (context.account.revision !== input.accountRevision || context.epochId !== input.epochId) throw new HttpError(409, "agent_inbox_changed");
  if ((row.review_revision ?? 0) !== input.expectedRevision) {
    const raced = await agentReviewOperation(env, identity.userId, key); if (raced) return replay(raced);
    throw new HttpError(409, "agent_review_changed");
  }
  const target = input.threadId ? `AND EXISTS(SELECT 1 FROM agent_threads t JOIN agent_outgoing_messages o ON o.user_id=t.user_id AND o.thread_id=t.id
    WHERE t.user_id=? AND t.sender_account_id=? AND t.id=? AND o.submitted_at IS NOT NULL AND o.from_address=?)` : "";
  const id = crypto.randomUUID(), now = unixNow(), fence = "EXISTS(SELECT 1 FROM agent_review_operations WHERE id=? AND completed_at IS NULL)";
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO agent_review_operations(id,user_id,account_id,message_id,request_key,request_hash,account_revision,epoch_id,state,thread_id,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${agentAccountCredentialFence(identity)}
        AND EXISTS(SELECT 1 FROM agent_accounts WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM agent_inbox_state WHERE user_id=? AND account_id=? AND epoch_id=? AND cache_generation=?)
        AND EXISTS(SELECT 1 FROM agent_incoming_messages m JOIN agent_inbox_batches b ON b.id=m.batch_id
          WHERE m.user_id=? AND m.account_id=? AND m.id=? AND m.epoch_id=? AND m.purged_at IS NULL AND b.state='committed')
        AND COALESCE((SELECT revision FROM agent_incoming_reviews WHERE user_id=? AND account_id=? AND message_id=?),0)=?
        ${target} AND (SELECT COUNT(*) FROM agent_review_operations WHERE user_id=?)<10000 ON CONFLICT(user_id,request_key) DO NOTHING`)
        .bind(id, identity.userId, accountId, messageId, key, hash, input.accountRevision, input.epochId, input.state, input.threadId, now,
          identity.credentialId, identity.userId, identity.userId, accountId, input.accountRevision,
          identity.userId, accountId, input.epochId, context.generation, identity.userId, accountId, messageId, input.epochId,
          identity.userId, accountId, messageId, input.expectedRevision,
          ...(input.threadId ? [identity.userId, accountId, input.threadId, context.account.email_address] : []), identity.userId),
      env.DB.prepare(`INSERT INTO agent_incoming_reviews(user_id,account_id,message_id,state,thread_id,revision,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE ${fence} ON CONFLICT(user_id,account_id,message_id)
        DO UPDATE SET state=excluded.state,thread_id=excluded.thread_id,revision=excluded.revision,updated_at=excluded.updated_at`)
        .bind(identity.userId, accountId, messageId, input.state, input.threadId, input.expectedRevision + 1, now, id),
      env.DB.prepare(`UPDATE agent_review_operations SET revision=?,completed_at=? WHERE id=? AND completed_at IS NULL`)
        .bind(input.expectedRevision + 1, now, id),
    ]);
  } catch { throw new HttpError(503, "agent_review_storage_failed"); }
  const result = await agentReviewOperation(env, identity.userId, key);
  if (result) return result.id === id ? { operation: await completed(env, identity, result), replayed: false } : replay(result);
  if (!await env.DB.prepare(`SELECT 1 WHERE ${agentAccountCredentialFence(identity)}`).bind(identity.credentialId, identity.userId).first()) throw new HttpError(401, "unauthorized");
  const current = await agentInboxContext(env, identity, accountId); await agentIncomingMessage(env, current, messageId);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_review_operations WHERE user_id=?").bind(identity.userId).first<number>("n");
  if (count !== null && count >= 10000) throw new HttpError(409, "agent_review_operation_limit");
  throw new HttpError(409, input.threadId ? "agent_review_target_or_source_changed" : "agent_review_changed_or_limit");
}
