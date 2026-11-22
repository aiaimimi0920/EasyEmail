import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions } from "./http";
import { requireScope } from "./identity";
import { enqueueSendJob } from "./send-job-enqueue";
import { sendJobAction } from "./send-job-actions";
import { jobView, ownedJob, type SendJob } from "./send-job-model";
import type { OutgoingRow } from "./outgoing-store";

const ROOT = "/api/v1/send-jobs";
const MAILBOX = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/send-jobs$/;
const ITEM = /^\/api\/v1\/send-jobs\/([0-9a-f-]{36})(?:\/(cancel|retry))?$/;
export const isSendJobPath = (path: string) => path === ROOT || MAILBOX.test(path) || ITEM.test(path);

export async function sendJobRoute(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url), mailbox = MAILBOX.exec(url.pathname), item = ITEM.exec(url.pathname);
  if (mailbox && request.method === "POST") return enqueueSendJob(request, env, identity, mailbox[1]);
  if (item?.[2] && request.method === "POST") return sendJobAction(request, env, identity, item[1], item[2] as "cancel" | "retry");
  if (request.method !== "GET" || mailbox || item?.[2]) throw new HttpError(405, "method_not_allowed");
  requireScope(identity, "messages:read");
  if (item) return json({ job: await jobView(env, await ownedJob(env, identity, item[1])) });
  const { limit, cursor } = pageOptions(url);
  const after = cursor ? await ownedJob(env, identity, cursor) : null;
  const { results } = await env.DB.prepare(`SELECT * FROM send_jobs WHERE user_id=?
    ${after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
    .bind(identity.userId, ...(after ? [after.created_at, after.created_at, cursor] : []), limit + 1).all<SendJob>();
  const items = results.slice(0, limit);
  const history = items.length ? await env.DB.prepare(`SELECT * FROM outgoing_messages WHERE user_id=?
    AND request_key IN (SELECT value FROM json_each(?))`).bind(identity.userId, JSON.stringify(items.map(row => row.outgoing_key))).all<OutgoingRow>() : { results: [] };
  const outgoing = new Map(history.results.map(row => [row.request_key, row]));
  return json({ items: await Promise.all(items.map(row => jobView(env, row, false, outgoing.get(row.outgoing_key) ?? null))),
    nextCursor: results.length > limit ? items.at(-1)!.id : null });
}
