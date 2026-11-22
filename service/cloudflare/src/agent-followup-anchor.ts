import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { rfcMessageId } from "./mail-address";
import type { AgentFollowupInput } from "./agent-followup-input";
import { ownedAgentTask } from "./agent-task-store";
import { ownedAgentFollowup } from "./agent-followup-store";
import { agentInboxContext, agentIncomingMessage } from "./agent-inbox-access";
import { agentInboxSourceHash } from "./agent-inbox-claim";
import { AGENT_REVIEW_JOIN, AGENT_EFFECTIVE_THREAD } from "./agent-review-model";

export async function agentFollowupAnchor(env: Env, identity: Identity, threadId: string, input: AgentFollowupInput, from: string, to: string) {
  const invalid = () => new HttpError(409, "agent_followup_anchor_changed");
  let own: string | null, chain: string[] = [], sql: string, values: (string | number)[];
  if (input.replyToType === "incoming") {
    const context = await agentInboxContext(env, identity, input.senderAccountId), row = await agentIncomingMessage(env, context, input.replyToId);
    const effective = row.inbound_thread_id && row.inbound_review_revision === (row.review_revision ?? 0) ? row.inbound_thread_id
      : row.review_state === "linked" ? row.review_thread_id : row.review_state ? null : row.thread_id;
    if (effective !== threadId || row.sender_address !== to) throw invalid();
    own = row.rfc_message_id;
    sql = `EXISTS(SELECT 1 FROM agent_incoming_messages m JOIN agent_inbox_batches b ON b.id=m.batch_id
      JOIN agent_inbox_state s ON s.user_id=m.user_id AND s.account_id=m.account_id ${AGENT_REVIEW_JOIN}
      WHERE m.user_id=? AND m.account_id=? AND m.id=? AND m.epoch_id=? AND m.purged_at IS NULL AND b.state='committed'
      AND s.epoch_id=m.epoch_id AND s.source_hash=? AND s.cache_generation=? AND COALESCE(r.revision,0)=?
      AND (${AGENT_EFFECTIVE_THREAD})=? AND m.rfc_message_id=? AND m.sender_address=?)`;
    values = [identity.userId, input.senderAccountId, row.id, row.epoch_id, await agentInboxSourceHash(context.account), context.generation,
      row.review_revision ?? 0, threadId, own ?? "", to];
  } else if (input.replyToType === "task") {
    const row = await ownedAgentTask(env, identity.userId, input.replyToId);
    if (row.id !== threadId || row.submitted_at === null || row.from_address !== from || row.to_address !== to) throw invalid();
    own = row.rfc_message_id;
    sql = "EXISTS(SELECT 1 FROM agent_outgoing_messages WHERE user_id=? AND thread_id=? AND submitted_at IS NOT NULL AND rfc_message_id=? AND from_address=? AND to_address=?)";
    values = [identity.userId, threadId, own, from, to];
  } else {
    const row = await ownedAgentFollowup(env, identity.userId, input.replyToId);
    if (row.thread_id !== threadId || row.submitted_at === null || row.from_address !== from || row.to_address !== to) throw invalid();
    own = row.rfc_message_id; chain = JSON.parse(row.references_json) as string[];
    sql = "EXISTS(SELECT 1 FROM agent_followups WHERE user_id=? AND id=? AND thread_id=? AND submitted_at IS NOT NULL AND rfc_message_id=? AND from_address=? AND to_address=?)";
    values = [identity.userId, row.id, threadId, own, from, to];
  }
  if (!rfcMessageId(own)) throw invalid();
  // Bounded, server-owned headers only; incoming content is not pinned or executed by an outgoing intent.
  const references = [...new Set([...chain.filter(value => rfcMessageId(value)), own!])].slice(-24);
  return { inReplyTo: own!, references, sql, values };
}
