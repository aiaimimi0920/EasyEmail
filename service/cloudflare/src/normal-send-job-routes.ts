import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions } from "./http";
import { requireScope } from "./identity";
import { enqueueNormalSendJob } from "./normal-send-job-enqueue";
import { sendJobAction } from "./send-job-actions";
import { jobByKey, jobView, ownedJob, type SendJob } from "./send-job-model";
import { NORMAL_JOBS } from "./send-job-source";
import type { NormalOutgoing } from "./normal-outgoing-store";

const PATH = /^\/api\/v1\/normal-accounts\/([0-9a-f-]{36})\/send-jobs(?:\/([0-9a-f-]{36})(?:\/(cancel|retry))?)?$/;
export const isNormalSendJobPath = (path: string) => PATH.test(path);
export async function normalSendJobRoute(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url), [, accountId, id, action] = PATH.exec(url.pathname)!;
  if (!id && request.method === "POST") return enqueueNormalSendJob(request, env, identity, accountId);
  if (action && request.method === "POST") return sendJobAction(request, env, identity, id, action as "cancel" | "retry", NORMAL_JOBS, accountId);
  if (request.method !== "GET" || action) throw new HttpError(405, "method_not_allowed");
  requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read");
  if (id) return json({ job: await jobView(env, await ownedJob(env, identity, id, NORMAL_JOBS, accountId)) });
  const key = url.searchParams.get("requestKey");
  if (key !== null) {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key) || url.searchParams.size !== 1) throw new HttpError(400, "invalid_send_request");
    const row = await jobByKey(env, identity, key, NORMAL_JOBS);
    if (!row || row.account_id !== accountId) throw new HttpError(404, "not_found");
    return json({ job: await jobView(env, row) });
  }
  const { limit, cursor } = pageOptions(url), after = cursor ? await ownedJob(env, identity, cursor, NORMAL_JOBS, accountId) : null;
  const { results } = await env.DB.prepare(`SELECT * FROM normal_send_jobs WHERE user_id=? AND account_id=?
    ${after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
    .bind(identity.userId, accountId, ...(after ? [after.created_at, after.created_at, cursor] : []), limit + 1).all<SendJob>();
  const items = results.slice(0, limit);
  const history = items.length ? await env.DB.prepare(`SELECT * FROM normal_outgoing_messages WHERE user_id=? AND account_id=?
    AND request_key IN (SELECT value FROM json_each(?))`).bind(identity.userId, accountId, JSON.stringify(items.map(row => row.outgoing_key))).all<NormalOutgoing>() : { results: [] };
  const outgoing = new Map(history.results.map(row => [row.request_key, row]));
  return json({ items: await Promise.all(items.map(row => jobView(env, row, false, outgoing.get(row.outgoing_key) ?? null))),
    nextCursor: results.length > limit ? items.at(-1)!.id : null });
}
