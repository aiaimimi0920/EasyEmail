import type { Env, Identity } from "./contracts";
import { requireScope } from "./identity";
import { messageView, type MessageStateRow } from "./message-view";
import { temporarySubscriptionSelection } from "./subscription-query";
import { normalSubscriptionSelection } from "./normal-subscription-query";
import { normalAggregateView, type NormalAggregateRow } from "./normal-aggregate-query";
import { subscriptionRows, subscriptionView, subscriptionVisibility } from "./subscription-page-query";
import { ensureNormalSubscriptions } from "./normal-subscription-index";
import { normalSearchContexts, ensureNormalSearch, assertNormalSearchCurrent } from "./normal-search-index";
import { unifiedQuery, unifiedSourceParams, sourceWindow, unifiedCursor } from "./unified-inbox-query";

export async function unifiedSubscriptions(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url), visibility = subscriptionVisibility(url), { sources, accountId } = unifiedSourceParams(url);
  if (sources !== "temporary") requireScope(identity, "mail-accounts:read");
  const contexts = sources !== "temporary" ? await normalSearchContexts(env, identity, accountId) : [];
  const { filters, limit, cursor, filter } = await unifiedQuery(url, `subscriptions-unified:${identity.userId}:${visibility}`, contexts);
  const includeNormal = sources !== "temporary" && !filters.mailboxId && !filters.providerId;
  if (includeNormal) { await ensureNormalSubscriptions(env, identity, contexts, accountId); await ensureNormalSearch(env, identity, contexts, accountId); }
  const rows: { sortTime: number; id: string; sourceKind: "temporary" | "normal"; item: unknown }[] = [];
  if (sources !== "normal" && !accountId) {
    const selection = await temporarySubscriptionSelection(env, identity, filters, visibility);
    for (const row of await subscriptionRows<MessageStateRow & { mailboxId: string }>(env, selection, limit, sourceWindow("temporary", cursor))) {
      rows.push({ sortTime: row.sortTime, id: row.id, sourceKind: "temporary", item: subscriptionView(row,
        latest => ({ ...messageView(latest), sourceKind: "temporary" }), { sourceKind: "temporary", mailboxId: row.mailboxId }) });
    }
  }
  if (includeNormal) {
    const selection = await normalSubscriptionSelection(env, identity, contexts, filters, visibility);
    for (const row of await subscriptionRows<NormalAggregateRow>(env, selection, limit, sourceWindow("normal", cursor))) {
      rows.push({ sortTime: row.sortTime, id: row.id, sourceKind: "normal", item: subscriptionView(row, normalAggregateView,
        { sourceKind: "normal", accountId: row.account_id, epochId: row.epoch_id }) });
    }
  }
  rows.sort((a, b) => b.sortTime - a.sortTime || (a.sourceKind < b.sourceKind ? 1 : a.sourceKind > b.sourceKind ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  if (sources !== "temporary") await assertNormalSearchCurrent(env, identity, contexts, accountId);
  const page = rows.slice(0, limit), last = page.at(-1);
  return { items: page.map(row => row.item), sources, cachedOnly: true,
    nextCursor: rows.length > limit && last ? unifiedCursor({ time: last.sortTime, id: last.id, sourceKind: last.sourceKind }, filter) : null };
}
