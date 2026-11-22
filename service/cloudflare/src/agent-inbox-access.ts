import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import { agentAccountCredentialFence } from "./agent-account-store";
import type { AgentAccount } from "./agent-account-model";
import { agentInboxSourceHash } from "./agent-inbox-claim";
import { AGENT_REVIEW_COLUMNS, AGENT_REVIEW_JOIN, type AgentReviewFields } from "./agent-review-model";

export interface AgentInboxContext { account: AgentAccount; epochId: string | null; generation: number }
export interface AgentIncomingMessage extends AgentReviewFields {
  id: string; account_id: string; epoch_id: string; uid: number; raw_key: string; content_key: string;
  raw_sha256: string; content_sha256: string; raw_bytes: number; content_bytes: number;
  received_at: number; observed_at: number; flags: string; summary: string;
  sender_address: string | null; rfc_message_id: string | null; association: string; service_id: string | null; thread_id: string | null;
}
export async function agentInboxContext(env: Env, identity: Identity, id: string): Promise<AgentInboxContext> {
  requireScope(identity, "agent-inbox:read");
  const account = await env.DB.prepare(`SELECT * FROM agent_accounts WHERE id=? AND user_id=? AND deleted_at IS NULL AND ${agentAccountCredentialFence(identity)}`)
    .bind(id, identity.userId, identity.credentialId, identity.userId).first<AgentAccount>();
  if (!account) throw new HttpError(404, "not_found");
  const state = await env.DB.prepare("SELECT source_hash,epoch_id,cache_generation FROM agent_inbox_state WHERE account_id=? AND user_id=?")
    .bind(id, identity.userId).first<{ source_hash: string | null; epoch_id: string | null; cache_generation: number }>();
  return { account, epochId: state?.source_hash === await agentInboxSourceHash(account) ? state!.epoch_id : null, generation: state?.cache_generation ?? 0 };
}
export async function assertAgentInboxCurrent(env: Env, identity: Identity, context: AgentInboxContext) {
  const actual = await agentInboxContext(env, identity, context.account.id);
  if (actual.account.revision !== context.account.revision || actual.epochId !== context.epochId || actual.generation !== context.generation)
    throw new HttpError(409, "agent_inbox_changed");
}
export async function agentIncomingMessage(env: Env, context: AgentInboxContext, id: string) {
  if (!context.epochId) throw new HttpError(404, "not_found");
  const row = await env.DB.prepare(`SELECT m.*,${AGENT_REVIEW_COLUMNS} FROM agent_incoming_messages m JOIN agent_inbox_batches b ON b.id=m.batch_id ${AGENT_REVIEW_JOIN}
    WHERE m.id=? AND m.user_id=? AND m.account_id=? AND m.epoch_id=? AND m.purged_at IS NULL AND b.state='committed'`)
    .bind(id, context.account.user_id, context.account.id, context.epochId).first<AgentIncomingMessage>();
  if (!row) throw new HttpError(404, "not_found"); return row;
}
