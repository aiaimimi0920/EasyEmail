import type { Env, Identity } from "./contracts";
import { json } from "./http";
import { requireScope } from "./identity";
import { queryInboxRows } from "./aggregate-inbox";
import { messageView } from "./message-view";
import { assertNormalSearchCurrent, ensureNormalSearch, normalSearchContexts } from "./normal-search-index";
import { normalAggregateRows, normalAggregateView } from "./normal-aggregate-query";
import { sourceWindow, unifiedCursor, unifiedQuery, unifiedSourceParams } from "./unified-inbox-query";

export async function unifiedInbox(request: Request, env: Env, identity: Identity) {
  requireScope(identity, "messages:read");
  const url = new URL(request.url), { sources, accountId } = unifiedSourceParams(url);
  if (sources !== "temporary") requireScope(identity, "mail-accounts:read");
  const contexts = sources !== "temporary" ? await normalSearchContexts(env, identity, accountId) : [];
  const query = await unifiedQuery(url, identity.userId, contexts), { filters, limit, cursor, filter } = query;
  if (sources !== "temporary" && !filters.mailboxId && !filters.providerId) await ensureNormalSearch(env, identity, contexts, accountId);
  const temporary = sources === "normal" || accountId ? [] : await queryInboxRows(env, identity, filters, limit, sourceWindow("temporary", cursor));
  const normal = sources === "temporary" ? [] : await normalAggregateRows(env, identity, contexts, filters, limit, sourceWindow("normal", cursor));
  const rows = [
    ...temporary.map(({ sortTime, ...row }) => ({ sortTime, item: { ...messageView(row), sourceKind: "temporary" as const } })),
    ...normal.map(row => ({ sortTime: row.sortTime, item: normalAggregateView(row) })),
  ].sort((a, b) => b.sortTime - a.sortTime || (a.item.sourceKind < b.item.sourceKind ? 1 : a.item.sourceKind > b.item.sourceKind ? -1 : a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0));
  if (sources !== "temporary") await assertNormalSearchCurrent(env, identity, contexts, accountId);
  const page = rows.slice(0, limit), last = page.at(-1);
  return json({ items: page.map(row => row.item), nextCursor: rows.length > limit && last
    ? unifiedCursor({ time: last.sortTime, id: last.item.id, sourceKind: last.item.sourceKind }, filter) : null,
    sources: query.sources, cachedOnly: true });
}
