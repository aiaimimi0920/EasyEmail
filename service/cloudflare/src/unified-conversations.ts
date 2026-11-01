import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import { messageView, type MessageStateRow } from "./message-view";
import { temporaryConversationSelection } from "./conversation-query";
import { normalConversationSelection } from "./normal-conversation-query";
import { normalAggregateView, type NormalAggregateRow } from "./normal-aggregate-query";
import { conversationRows, conversationMemberRows, conversationView } from "./conversation-page-query";
import { ensureNormalConversations } from "./normal-conversation-index";
import { normalSearchContexts, ensureNormalSearch, assertNormalSearchCurrent } from "./normal-search-index";
import { unifiedQuery, unifiedSourceParams, sourceWindow, unifiedCursor } from "./unified-inbox-query";

export async function unifiedConversations(request: Request, env: Env, identity: Identity, anchor = "") {
  const url = new URL(request.url), { sources, accountId } = unifiedSourceParams(url);
  if (sources !== "temporary") requireScope(identity, "mail-accounts:read");
  if (anchor && (sources === "all" || (sources === "normal" && !accountId))) throw new HttpError(400, "invalid_filter");
  const contexts = sources !== "temporary" ? await normalSearchContexts(env, identity, accountId) : [];
  const query = await unifiedQuery(url, `conversations-unified:${identity.userId}:${anchor}`, contexts), { filters, limit, cursor, filter } = query;
  const includeNormal = sources !== "temporary" && !filters.mailboxId && !filters.providerId;
  if (includeNormal) {
    await ensureNormalConversations(env, identity, contexts, accountId);
    await ensureNormalSearch(env, identity, contexts, accountId);
  }
  const rows: { sortTime: number; id: string; sourceKind: "temporary" | "normal"; item: unknown }[] = [];
  if (sources !== "normal" && !accountId) {
    const selection = await temporaryConversationSelection(env, identity, filters);
    if (anchor) for (const { sortTime, ...row } of await conversationMemberRows<MessageStateRow>(env, selection, anchor, limit, cursor)) {
      rows.push({ sortTime, id: row.id, sourceKind: "temporary", item: { ...messageView(row), sourceKind: "temporary" } });
    } else for (const row of await conversationRows<MessageStateRow & { mailboxId: string }>(env, selection, limit, sourceWindow("temporary", cursor))) {
      rows.push({ sortTime: row.sortTime, id: row.id, sourceKind: "temporary", item: conversationView(row, latest => ({ ...messageView(latest), sourceKind: "temporary" }), { sourceKind: "temporary", mailboxId: row.mailboxId }) });
    }
  }
  if (includeNormal) {
    const selection = await normalConversationSelection(env, identity, contexts, filters);
    if (anchor) for (const { sortTime, ...row } of await conversationMemberRows<NormalAggregateRow>(env, selection, anchor, limit, cursor)) {
      rows.push({ sortTime, id: row.id, sourceKind: "normal", item: normalAggregateView({ ...row, sortTime }) });
    } else for (const row of await conversationRows<NormalAggregateRow>(env, selection, limit, sourceWindow("normal", cursor))) {
      rows.push({ sortTime: row.sortTime, id: row.id, sourceKind: "normal", item: conversationView(row, normalAggregateView,
        { sourceKind: "normal", accountId: row.account_id, epochId: row.epoch_id }) });
    }
  }
  rows.sort((a, b) => anchor ? a.sortTime - b.sortTime || a.id.localeCompare(b.id)
    : b.sortTime - a.sortTime || (a.sourceKind < b.sourceKind ? 1 : a.sourceKind > b.sourceKind ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  if (sources !== "temporary") await assertNormalSearchCurrent(env, identity, contexts, accountId);
  const page = rows.slice(0, limit), last = page.at(-1);
  return { items: page.map(row => row.item), sources, cachedOnly: true,
    nextCursor: rows.length > limit && last ? unifiedCursor({ time: last.sortTime, id: last.id, sourceKind: last.sourceKind }, filter) : null };
}
