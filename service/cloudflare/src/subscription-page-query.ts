import type { Env } from "./contracts";
import { HttpError } from "./http";

const TIME = "COALESCE(m.received_at,m.observed_at)";
export interface SubscriptionSelection {
  visible: string; values: (string | number)[]; matches: string; matchValues: (string | number)[];
  partition: string[]; summary: string; methodOwner: string; visibility: string;
}
export interface SubscriptionStats {
  id: string; subscriptionKey: string; subscriptionName: string; listId: string; subscriptionSender: string;
  hidden: number; preferenceVersion: number; messageCount: number; unreadCount: number; limited: number;
  groupMethods: string; tooManyMethods: number; sortTime: number; position: number; matched: number;
}
type Window = { time: number; id: string } | null;
export function subscriptionVisibility(url: URL) {
  const visibility = url.searchParams.get("visibility") ?? "active";
  if (url.searchParams.getAll("visibility").length > 1 || !["active", "hidden", "all"].includes(visibility)) throw new HttpError(400, "invalid_filter");
  url.searchParams.delete("visibility");
  if (!url.searchParams.has("folder")) url.searchParams.set("folder", "all");
  return visibility;
}
const hiddenFilter = (visibility: string) => visibility === "all" ? "" : `AND hidden=${visibility === "hidden" ? 1 : 0}`;
export async function subscriptionRows<T>(env: Env, selection: SubscriptionSelection, limit: number, cursor: Window) {
  const { visible, values, matches, matchValues, partition, summary, methodOwner, visibility } = selection;
  const group = [...partition.map(column => `m.${column}`), "m.subscriptionKey"].join(",");
  const methods = `SELECT DISTINCT j.value FROM visible v,json_each(v.methods) j WHERE ${methodOwner} AND v.subscriptionKey=m.subscriptionKey ORDER BY j.value`;
  return (await env.DB.prepare(`WITH ${visible},ranked AS (SELECT ${summary},
    m.subscriptionKey,m.subscriptionName,m.listId,m.subscriptionSender,m.hidden,m.preferenceVersion,${TIME} AS sortTime,
    ROW_NUMBER() OVER(PARTITION BY ${group} ORDER BY ${TIME} DESC,m.id DESC) AS position,COUNT(*) OVER(PARTITION BY ${group}) AS messageCount,
    SUM(1-m.is_read) OVER(PARTITION BY ${group}) AS unreadCount,MAX(m.subscriptionLimited) OVER(PARTITION BY ${group}) AS limited,
    MAX(CASE WHEN ${matches} THEN 1 ELSE 0 END) OVER(PARTITION BY ${group}) AS matched FROM visible m)
    SELECT m.*,(SELECT json_group_array(value) FROM (${methods} LIMIT 8)) AS groupMethods,
    (SELECT COUNT(*)>8 FROM (${methods} LIMIT 9)) AS tooManyMethods FROM ranked m WHERE position=1 AND matched=1 ${hiddenFilter(visibility)}
    ${cursor ? "AND (sortTime<? OR (sortTime=? AND m.id<?))" : ""} ORDER BY sortTime DESC,m.id DESC LIMIT ?`)
    .bind(...values, ...matchValues, ...(cursor ? [cursor.time, cursor.time, cursor.id] : []), limit + 1).all<T & SubscriptionStats>()).results;
}
export async function subscriptionMemberRows<T>(env: Env, selection: SubscriptionSelection, key: string, limit: number, cursor: Window) {
  const { visible, values, matches, matchValues, summary, visibility } = selection;
  const cte = `${visible},target AS (SELECT * FROM visible WHERE subscriptionKey=? ${hiddenFilter(visibility)})`;
  const bindings = [...values, key, ...matchValues];
  if (!await env.DB.prepare(`WITH ${cte} SELECT 1 FROM target m WHERE ${matches} LIMIT 1`).bind(...bindings).first()) throw new HttpError(404, "not_found");
  return (await env.DB.prepare(`WITH ${cte} SELECT ${summary},${TIME} AS sortTime FROM target m
    WHERE EXISTS(SELECT 1 FROM target m WHERE ${matches}) ${cursor ? `AND (${TIME}>? OR (${TIME}=? AND m.id>?))` : ""}
    ORDER BY ${TIME},m.id LIMIT ?`).bind(...bindings, ...(cursor ? [cursor.time, cursor.time, cursor.id] : []), limit + 1).all<T & { id: string; sortTime: number }>()).results;
}
export function subscriptionView<T>(row: T & SubscriptionStats, view: (latest: T) => unknown, owner: object) {
  const { subscriptionKey, subscriptionName, listId, subscriptionSender, hidden, preferenceVersion, messageCount, unreadCount,
    limited, groupMethods, tooManyMethods, sortTime: _sort, position: _pos, matched: _matched, ...latest } = row;
  return { id: subscriptionKey, ...owner, name: subscriptionName, listId, senderAddress: subscriptionSender,
    hidden: hidden === 1, version: preferenceVersion, messageCount, unreadCount, limited: limited === 1 || tooManyMethods === 1,
    methods: JSON.parse(groupMethods) as string[], latest: view(latest as T) };
}
