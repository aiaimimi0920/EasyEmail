import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { agentInboxContext, agentIncomingMessage, assertAgentInboxCurrent, type AgentIncomingMessage } from "./agent-inbox-access";
import { normalContent, normalSummary } from "./normal-inbox-objects";
import { downloadable } from "./attachment-policy";
import { AGENT_REVIEW_COLUMNS, AGENT_REVIEW_JOIN, AGENT_EFFECTIVE_THREAD, AGENT_NEEDS_ATTENTION, agentReviewView, agentInboundMembership } from "./agent-review-model";

const associations = ["linked", "unmatched", "ambiguous", "unknown_service", "service_unavailable", "invalid_headers"];
function summary(row: AgentIncomingMessage) {
  let header;
  try { header = normalSummary(JSON.parse(row.summary)); } catch { throw new HttpError(503, "agent_content_unavailable"); }
  return { id: row.id, accountId: row.account_id, epochId: row.epoch_id, uid: row.uid, ...header,
    receivedAt: row.received_at, observedAt: row.observed_at, remoteFlags: JSON.parse(row.flags) as string[],
    senderAddress: row.sender_address, rfcMessageId: row.rfc_message_id, association: row.association,
    serviceId: row.service_id, threadId: row.thread_id, authentication: "unverified" as const, review: agentReviewView(row), inboundThread: agentInboundMembership(row) };
}
export async function listAgentIncoming(request: Request, env: Env, identity: Identity, accountId: string) {
  const context = await agentInboxContext(env, identity, accountId), params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !["limit", "cursor", "association", "threadId", "review"].includes(key) || params.getAll(key).length !== 1)) throw new HttpError(400, "invalid_filter");
  const raw = params.get("limit") ?? "20", cursor = params.get("cursor"), association = params.get("association"), threadId = params.get("threadId");
  if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 20) throw new HttpError(400, "invalid_limit");
  if (association !== null && !associations.includes(association) || threadId !== null && !AGENT_ACCOUNT_UUID.test(threadId)) throw new HttpError(400, "invalid_filter");
  const review = params.get("review");
  if (review !== null && !["attention", "handled"].includes(review)) throw new HttpError(400, "invalid_filter");
  const suffix = `:${association ?? "all"}:${threadId ?? "all"}${review ? `:${review}` : ""}`;
  let before = 4294967296;
  if (cursor !== null) {
    const match = /^([0-9a-f-]{36}):([1-9]\d{0,9})(:.*)$/.exec(cursor);
    if (!match || match[1] !== context.epochId || Number(match[2]) > 4294967295 || match[3] !== suffix) throw new HttpError(400, "invalid_cursor");
    before = Number(match[2]);
  }
  const rows = context.epochId ? (await env.DB.prepare(`SELECT m.*,${AGENT_REVIEW_COLUMNS} FROM agent_incoming_messages m JOIN agent_inbox_batches b ON b.id=m.batch_id ${AGENT_REVIEW_JOIN}
    WHERE m.user_id=? AND m.account_id=? AND m.epoch_id=? AND m.uid<? AND m.purged_at IS NULL AND b.state='committed'
    ${association ? "AND m.association=?" : ""} ${threadId ? `AND (${AGENT_EFFECTIVE_THREAD})=?` : ""}
    ${review ? `AND ${review === "handled" ? "NOT " : ""}${AGENT_NEEDS_ATTENTION}` : ""} ORDER BY m.uid DESC LIMIT ?`)
    .bind(identity.userId, accountId, context.epochId, before, ...(association ? [association] : []), ...(threadId ? [threadId] : []), Number(raw) + 1).all<AgentIncomingMessage>()).results : [];
  const chosen = rows.slice(0, Number(raw)), items = chosen.map(summary);
  await assertAgentInboxCurrent(env, identity, context);
  return { items, nextCursor: rows.length > chosen.length ? `${context.epochId}:${chosen.at(-1)!.uid}${suffix}` : null,
    epochId: context.epochId, accountRevision: context.account.revision, sourceReady: !!context.epochId };
}
export async function getAgentIncoming(env: Env, identity: Identity, accountId: string, id: string) {
  const context = await agentInboxContext(env, identity, accountId), row = await agentIncomingMessage(env, context, id);
  const content = await normalContent(env, row);
  if (content.recipient !== context.account.email_address) throw new HttpError(503, "agent_content_unavailable");
  const message = { ...summary(row), content: { textBody: content.textBody, htmlBody: content.htmlBody,
    attachmentsTruncated: content.attachmentsTruncated, attachments: content.attachments.map(part => ({ filename: part.filename, size: part.size, downloadAvailable: downloadable(part) })) } };
  await assertAgentInboxCurrent(env, identity, context);
  await agentIncomingMessage(env, context, id);
  return { message };
}
