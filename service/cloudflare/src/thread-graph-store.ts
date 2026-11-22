import type { Env } from "./contracts";
import type { ThreadPlan } from "./message-thread-model";

export interface ThreadTarget { where: string; values: (string | number | null)[] }
// Storage descriptors are code-owned SQL identifiers, never request input.
export interface ThreadStorage {
  messages: string; links: string; messageScope: string; messageValues: string[];
  linkOwner: Record<string, string>; alive: string;
}
export function graphWriteStatements(env: Env, storage: ThreadStorage, target: ThreadTarget, plan: ThreadPlan) {
  const { messages, links, alive, messageScope, messageValues, linkOwner } = storage;
  const columns = Object.keys(linkOwner), owners = Object.values(linkOwner), scope = columns.map(column => `${column}=?`).join(" AND ");
  const candidate = `candidate AS (SELECT m.id FROM ${messages} m WHERE ${target.where} AND ${alive} AND m.thread_version<?)`;
  const initial = [...target.values, plan.version];
  if (!plan.tokens.length) return [env.DB.prepare(`WITH ${candidate} UPDATE ${messages} SET
    thread_key=CASE WHEN thread_basis='headers' THEN thread_key ELSE COALESCE(?, 'm:'||id) END,
    thread_basis=CASE WHEN thread_basis='headers' THEN thread_basis ELSE ? END,thread_version=?,thread_limited=?
    WHERE id IN (SELECT id FROM candidate)`)
    .bind(...initial, plan.fallback ? `s:${plan.fallback}` : null, plan.fallback ? "subject" : "single", plan.version, Number(plan.limited))];
  const connections = `connections AS (SELECT DISTINCT group_id FROM ${links} WHERE ${scope}
    AND (token IN (SELECT value FROM json_each(?)) OR message_id IN (SELECT id FROM candidate)))`;
  const parameters = [...initial, ...owners, JSON.stringify(plan.tokens)];
  return [
    env.DB.prepare(`WITH ${candidate},${connections} INSERT INTO ${links}(${columns.join(",")},message_id,token,group_id)
      SELECT ${owners.map(() => "?").join(",")},c.id,j.value,COALESCE((SELECT MIN(group_id) FROM connections),c.id) FROM candidate c,json_each(?) j WHERE 1
      ON CONFLICT(${columns.join(",")},message_id,token) DO NOTHING`).bind(...parameters, ...owners, JSON.stringify(plan.tokens)),
    env.DB.prepare(`WITH ${candidate},${connections} UPDATE ${links} SET group_id=(SELECT MIN(group_id) FROM connections)
      WHERE ${scope} AND group_id IN (SELECT group_id FROM connections) AND EXISTS(SELECT 1 FROM candidate)`)
      .bind(...parameters, ...owners),
    env.DB.prepare(`WITH ${candidate},${connections} UPDATE ${messages} AS m SET thread_key='h:'||(SELECT MIN(group_id) FROM connections),thread_basis='headers'
      WHERE ${messageScope} AND ${alive} AND id IN
      (SELECT message_id FROM ${links} WHERE ${scope} AND group_id=(SELECT MIN(group_id) FROM connections))
      AND EXISTS(SELECT 1 FROM candidate)`).bind(...parameters, ...messageValues, ...owners),
    env.DB.prepare(`WITH ${candidate} UPDATE ${messages} SET thread_version=?,thread_limited=? WHERE id IN(SELECT id FROM candidate)`)
      .bind(...initial, plan.version, Number(plan.limited)),
  ];
}
