import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { encodeInboxCursor, inboxQuery } from "./inbox-query";
import { normalAggregateView, type NormalAggregateRow } from "./normal-aggregate-query";
import { normalMessageSelection } from "./normal-message-selection";
import { normalSearchContexts, ensureNormalSearch, assertNormalSearchCurrent, type NormalSearchContext } from "./normal-search-index";
import { ensureNormalSubscriptions } from "./normal-subscription-index";
import { subscriptionVisibility, subscriptionMemberRows } from "./subscription-page-query";

export async function normalSubscriptionSelection(env: Env, identity: Identity, contexts: NormalSearchContext[], filters: Awaited<ReturnType<typeof inboxQuery>>["filters"], visibility: string) {
  const base = await normalMessageSelection(env, identity, contexts, filters, "normal_base");
  return { ...base, visibility, methodOwner: "v.account_id=m.account_id AND v.epoch_id=m.epoch_id",
    visible: `${base.visible},visible AS (SELECT m.*,ns.subscription_key AS subscriptionKey,ns.display_name AS subscriptionName,
    ns.list_id AS listId,ns.sender_address AS subscriptionSender,ns.unsubscribe_methods AS methods,ns.limited AS subscriptionLimited,
    COALESCE(p.hidden,0) AS hidden,COALESCE(p.version,0) AS preferenceVersion FROM normal_base m
    JOIN normal_message_subscriptions ns ON ns.user_id=? AND ns.account_id=m.account_id AND ns.epoch_id=m.epoch_id AND ns.message_id=m.id
    LEFT JOIN normal_subscription_preferences p ON p.user_id=ns.user_id AND p.account_id=ns.account_id AND p.epoch_id=ns.epoch_id AND p.subscription_key=ns.subscription_key
    WHERE ns.subscription_key IS NOT NULL)`, values: [...base.values, identity.userId] };
}
export async function normalSubscriptionMessages(request: Request, env: Env, identity: Identity, accountId: string, key: string) {
  const url = new URL(request.url), epoch = url.searchParams.get("epochId"), visibility = subscriptionVisibility(url);
  if (url.searchParams.getAll("epochId").length !== 1 || !epoch || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(epoch)) throw new HttpError(400, "invalid_filter");
  url.searchParams.delete("epochId");
  const contexts = await normalSearchContexts(env, identity, accountId);
  if (!contexts.some(context => context.epochId === epoch)) throw new HttpError(409, "normal_account_changed");
  const { filters, limit, cursor, fingerprint } = await inboxQuery(url, `normal-subscription-members:${identity.userId}:${accountId}:${epoch}:${key}:${visibility}:${JSON.stringify(contexts)}`);
  if (filters.mailboxId || filters.providerId) throw new HttpError(400, "normal_filter_unavailable");
  await ensureNormalSubscriptions(env, identity, contexts, accountId); await ensureNormalSearch(env, identity, contexts, accountId);
  const selection = await normalSubscriptionSelection(env, identity, contexts.filter(context => context.epochId === epoch), filters, visibility);
  const rows = await subscriptionMemberRows<NormalAggregateRow>(env, selection, key, limit, cursor), page = rows.slice(0, limit), last = page.at(-1);
  await assertNormalSearchCurrent(env, identity, contexts, accountId);
  return { items: page.map(normalAggregateView), cachedOnly: true,
    nextCursor: rows.length > limit && last ? encodeInboxCursor(last.sortTime, last.id, fingerprint) : null };
}
