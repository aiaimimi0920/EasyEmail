import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { encodeInboxCursor, inboxQuery } from "./inbox-query";
import { inboxSelection } from "./inbox-selection";
import { MESSAGE_SUMMARY, messageView, type MessageStateRow } from "./message-view";
import { indexCachedConversations } from "./conversation-index";
import { conversationRows, conversationMemberRows, conversationView } from "./conversation-page-query";

interface Row extends MessageStateRow { mailboxId: string }
export async function temporaryConversationSelection(env: Env, identity: Identity, filters: Awaited<ReturnType<typeof inboxQuery>>["filters"]) {
  const scope = await inboxSelection(env, identity, filters);
  if (await indexCachedConversations(env, identity)) throw new HttpError(503, "conversation_index_pending");
  return { ...scope, visible: `visible AS (SELECT m.*,b.address AS mailboxAddress,b.provider_id AS providerId,b.display_name AS mailboxDisplayName
    FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE ${scope.location})`,
    partition: ["mailbox_id"], summary: `${MESSAGE_SUMMARY},m.mailboxAddress,m.providerId,m.mailboxDisplayName` };
}
async function context(request: Request, env: Env, identity: Identity, anchor = "") {
  const parsed = await inboxQuery(new URL(request.url), `conversations:${identity.userId}:${anchor}`);
  return { ...parsed, selection: await temporaryConversationSelection(env, identity, parsed.filters) };
}
export async function listConversations(request: Request, env: Env, identity: Identity) {
  const { selection, limit, cursor, fingerprint } = await context(request, env, identity);
  const results = await conversationRows<Row>(env, selection, limit, cursor);
  const page = results.slice(0, limit), last = page.at(-1);
  return { items: page.map(row => conversationView(row, messageView, { mailboxId: row.mailboxId })),
    nextCursor: results.length > limit && last ? encodeInboxCursor(last.sortTime, last.id, fingerprint) : null };
}
export async function conversationMembers(request: Request, env: Env, identity: Identity, anchor: string) {
  const { selection, limit, cursor, fingerprint } = await context(request, env, identity, anchor);
  const results = await conversationMemberRows<MessageStateRow>(env, selection, anchor, limit, cursor);
  const page = results.slice(0, limit), last = page.at(-1);
  return { items: page.map(({ sortTime: _time, ...row }) => messageView(row)),
    nextCursor: results.length > limit && last ? encodeInboxCursor(last.sortTime, last.id, fingerprint) : null };
}
