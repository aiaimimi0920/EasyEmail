import type { Env } from "./contracts";
import { HttpError } from "./http";

export const CONVERSATION_TIME = "COALESCE(m.received_at,m.observed_at)", CONVERSATION_KEY = "COALESCE(m.thread_key,'m:'||m.id)";
export interface ConversationSelection {
  visible: string; values: (string | number)[]; matches: string; matchValues: (string | number)[];
  partition: string[]; summary: string;
}
export interface ConversationStats {
  id: string; sortTime: number; basis: string; messageCount: number; unreadCount: number; anyStarred: number; limited: number;
  position: number; matched: number;
}
type Window = { time: number; id: string } | null;
export async function conversationRows<T>(env: Env, selection: ConversationSelection, limit: number, cursor: Window) {
  const { visible, values, matches, matchValues, partition, summary } = selection;
  const group = [...partition.map(column => `m.${column}`), CONVERSATION_KEY].join(",");
  return (await env.DB.prepare(`WITH ${visible},ranked AS (SELECT ${summary},${CONVERSATION_TIME} AS sortTime,COALESCE(m.thread_basis,'single') AS basis,
    ROW_NUMBER() OVER(PARTITION BY ${group} ORDER BY ${CONVERSATION_TIME} DESC,m.id DESC) AS position,
    COUNT(*) OVER(PARTITION BY ${group}) AS messageCount,SUM(1-m.is_read) OVER(PARTITION BY ${group}) AS unreadCount,
    MAX(m.starred) OVER(PARTITION BY ${group}) AS anyStarred,MAX(m.thread_limited) OVER(PARTITION BY ${group}) AS limited,
    MAX(CASE WHEN ${matches} THEN 1 ELSE 0 END) OVER(PARTITION BY ${group}) AS matched FROM visible m)
    SELECT * FROM ranked WHERE position=1 AND matched=1 ${cursor ? "AND (sortTime<? OR (sortTime=? AND id<?))" : ""}
    ORDER BY sortTime DESC,id DESC LIMIT ?`).bind(...values, ...matchValues,
      ...(cursor ? [cursor.time, cursor.time, cursor.id] : []), limit + 1).all<T & ConversationStats>()).results;
}
export async function conversationMemberRows<T>(env: Env, selection: ConversationSelection, anchor: string, limit: number, cursor: Window) {
  const { visible, values, matches, matchValues, partition, summary } = selection;
  const cte = `${visible},target AS (SELECT ${partition.join(",")},${CONVERSATION_KEY} AS key FROM visible m WHERE m.id=?),
    members AS (SELECT m.* FROM visible m JOIN target t ON ${partition.map(column => `t.${column}=m.${column}`).join(" AND ")} AND t.key=${CONVERSATION_KEY})`;
  const bindings = [...values, anchor, ...matchValues];
  if (!await env.DB.prepare(`WITH ${cte} SELECT 1 AS allowed FROM members m WHERE ${matches} LIMIT 1`).bind(...bindings).first()) throw new HttpError(404, "not_found");
  return (await env.DB.prepare(`WITH ${cte} SELECT ${summary},${CONVERSATION_TIME} AS sortTime FROM members m
    WHERE EXISTS(SELECT 1 FROM members m WHERE ${matches}) ${cursor ? `AND (${CONVERSATION_TIME}>? OR (${CONVERSATION_TIME}=? AND m.id>?))` : ""}
    ORDER BY ${CONVERSATION_TIME},m.id LIMIT ?`).bind(...bindings,
      ...(cursor ? [cursor.time, cursor.time, cursor.id] : []), limit + 1).all<T & { id: string; sortTime: number }>()).results;
}
export function conversationView<T>(row: T & ConversationStats, view: (latest: T) => unknown, owner: object) {
  const { sortTime: _time, position: _position, matched: _matched, messageCount, unreadCount, anyStarred, limited, basis, ...latest } = row;
  return { id: row.id, ...owner, basis, limited: limited === 1, messageCount, unreadCount, starred: anyStarred === 1, latest: view(latest as T) };
}
