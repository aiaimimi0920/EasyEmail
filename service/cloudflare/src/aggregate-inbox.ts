import type { Env, Identity } from "./contracts";
import { json } from "./http";
import { requireScope } from "./identity";
import { encodeInboxCursor, inboxQuery } from "./inbox-query";
import { MESSAGE_SUMMARY, messageView, type MessageStateRow } from "./message-view";
import { inboxSelection } from "./inbox-selection";

const TIME = "COALESCE(m.received_at, m.observed_at)";

export async function queryInboxRows(env: Env, identity: Identity, filters: Awaited<ReturnType<typeof inboxQuery>>["filters"],
  limit: number, cursor: { time: number; id: string } | null) {
  const scope = await inboxSelection(env, identity, filters);
  const conditions = [scope.location, scope.matches];
  const values: (string | number)[] = [...scope.values, ...scope.matchValues];
  const add = (sql: string, ...bindings: (string | number)[]) => { conditions.push(sql); values.push(...bindings); };
  if (cursor) add(`(${TIME} < ? OR (${TIME} = ? AND m.id < ?))`, cursor.time, cursor.time, cursor.id);
  const { results } = await env.DB.prepare(`SELECT ${MESSAGE_SUMMARY}, ${TIME} AS sortTime,
    b.address AS mailboxAddress, b.provider_id AS providerId, b.display_name AS mailboxDisplayName
    FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE ${conditions.join(" AND ")}
    ORDER BY ${TIME} DESC, m.id DESC LIMIT ?`).bind(...values, limit + 1).all<MessageStateRow & { sortTime: number }>();
  return results;
}
export async function aggregateInbox(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireScope(identity, "messages:read");
  const { filters, limit, cursor, fingerprint } = await inboxQuery(new URL(request.url), identity.userId);
  const results = await queryInboxRows(env, identity, filters, limit, cursor), page = results.slice(0, limit);
  const last = page.at(-1);
  return json({ items: page.map(({ sortTime: _sortTime, ...row }) => messageView(row)),
    nextCursor: results.length > limit && last ? encodeInboxCursor(last.sortTime, last.id, fingerprint) : null });
}
