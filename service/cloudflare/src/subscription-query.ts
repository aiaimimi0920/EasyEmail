import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { encodeInboxCursor, inboxQuery } from "./inbox-query";
import { inboxSelection } from "./inbox-selection";
import { MESSAGE_SUMMARY, messageView, type MessageStateRow } from "./message-view";
import { subscriptionVisibility, subscriptionRows, subscriptionMemberRows, subscriptionView } from "./subscription-page-query";

type TemporaryRow = MessageStateRow & { mailboxId: string };
async function context(request: Request, env: Env, identity: Identity, mailboxId = "", key = "") {
  const url = new URL(request.url), visibility = subscriptionVisibility(url);
  if (mailboxId) {
    if (url.searchParams.has("mailboxId") && (url.searchParams.getAll("mailboxId").length !== 1 || url.searchParams.get("mailboxId") !== mailboxId)) throw new HttpError(400, "invalid_filter");
    url.searchParams.set("mailboxId", mailboxId);
  }
  const parsed = await inboxQuery(url, `subscriptions:${identity.userId}:${visibility}:${mailboxId}:${key}`);
  return { ...parsed, selection: await temporarySubscriptionSelection(env, identity, parsed.filters, visibility) };
}
export async function temporarySubscriptionSelection(env: Env, identity: Identity, filters: Awaited<ReturnType<typeof inboxQuery>>["filters"], visibility: string) {
  const scope = await inboxSelection(env, identity, filters);
  const visible = `visible AS (SELECT m.*,b.address AS mailboxAddress,b.provider_id AS providerId,b.display_name AS mailboxDisplayName,
    s.subscription_key AS subscriptionKey,s.display_name AS subscriptionName,s.list_id AS listId,s.sender_address AS subscriptionSender,
    s.unsubscribe_methods AS methods,s.limited AS subscriptionLimited,COALESCE(p.hidden,0) AS hidden,COALESCE(p.version,0) AS preferenceVersion
    FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id JOIN message_subscriptions s ON s.user_id=m.user_id AND s.mailbox_id=m.mailbox_id AND s.message_id=m.id
    LEFT JOIN subscription_preferences p ON p.user_id=m.user_id AND p.mailbox_id=m.mailbox_id AND p.subscription_key=s.subscription_key
    WHERE ${scope.location} AND s.subscription_key IS NOT NULL)`;
  return { visible, values: scope.values, matches: scope.matches, matchValues: scope.matchValues, visibility,
    summary: `${MESSAGE_SUMMARY},m.mailboxAddress,m.providerId,m.mailboxDisplayName`, partition: ["mailbox_id"], methodOwner: "v.mailbox_id=m.mailboxId" };
}
export async function listSubscriptions(request: Request, env: Env, identity: Identity) {
  const { selection, cursor, limit, fingerprint } = await context(request, env, identity);
  const results = await subscriptionRows<TemporaryRow>(env, selection, limit, cursor);
  const page = results.slice(0, limit), last = page.at(-1);
  return { items: page.map(row => subscriptionView(row, messageView, { mailboxId: row.mailboxId })),
    nextCursor: results.length > limit && last ? encodeInboxCursor(last.sortTime, last.id, fingerprint) : null };
}
export async function subscriptionMessages(request: Request, env: Env, identity: Identity, mailboxId: string, key: string) {
  const { selection, cursor, limit, fingerprint } = await context(request, env, identity, mailboxId, key);
  const results = await subscriptionMemberRows<TemporaryRow>(env, selection, key, limit, cursor);
  const page = results.slice(0, limit), last = page.at(-1);
  return { items: page.map(({ sortTime: _time, ...row }) => messageView(row)),
    nextCursor: results.length > limit && last ? encodeInboxCursor(last.sortTime, last.id, fingerprint) : null };
}
