import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, pageOptions } from "./http";
import { storedRecipients } from "./outgoing-recipients";
import { readRetention } from "./retention-policy";
import { storedOutbox } from "./outbox-references";

export interface NormalOutgoing {
  id: string; user_id: string; account_id: string; account_revision: number; smtp_revision: number; endpoint_hash: string;
  request_key: string; request_hash: string; from_address: string; to_address: string; recipients_json: string | null;
  recipient_count: number; subject: string; text_body: string; state: "pending" | "accepted" | "rejected" | "unknown";
  error_code: string | null; created_at: number; updated_at: number; content_purged_at: number | null;
  reply_message_id?: string | null; reply_threading?: "submitted" | "unavailable" | null;
  attachments_json?: string | null;
}
export const normalOutgoingByKey = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM normal_outgoing_messages WHERE user_id=? AND request_key=?").bind(userId, key).first<NormalOutgoing>();
export function normalOutgoingView(row: NormalOutgoing, detail = true) {
  const stale = row.state === "pending" && row.created_at <= unixNow() - 60;
  return { id: row.id, accountId: row.account_id, accountRevision: row.account_revision, smtpRevision: row.smtp_revision, requestKey: row.request_key,
    from: row.from_address, ...storedRecipients(row), subject: row.subject, ...(detail ? { text: row.text_body } : {}),
    ...(row.attachments_json ? { attachments: storedOutbox(row) } : {}),
    state: stale ? "unknown" : row.state, error: stale ? "smtp_outcome_unknown" : row.error_code,
    retrySafe: false, delivery: "unconfirmed", createdAt: row.created_at, updatedAt: row.updated_at, contentPurgedAt: row.content_purged_at,
    ...(row.reply_message_id ? { replyToMessageId: row.reply_message_id, threading: row.reply_threading } : {}) };
}
export function replayNormalOutgoing(row: NormalOutgoing, hash: string, initial = false) {
  if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
  const outgoing = normalOutgoingView(row);
  return json({ outgoing }, ["pending", "unknown"].includes(outgoing.state) ? 202 : initial && outgoing.state === "accepted" ? 201 : 200);
}
export async function readNormalOutgoing(request: Request, env: Env, identity: Identity, accountId: string) {
  const url = new URL(request.url), key = url.searchParams.get("requestKey");
  if (key !== null) {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key) || url.searchParams.size !== 1) throw new HttpError(400, "invalid_send_request");
    const row = await normalOutgoingByKey(env, identity.userId, key);
    if (!row || row.account_id !== accountId) throw new HttpError(404, "not_found");
    return json({ outgoing: normalOutgoingView(row) });
  }
  const { limit, cursor } = pageOptions(url);
  const after = cursor ? await env.DB.prepare("SELECT created_at FROM normal_outgoing_messages WHERE id=? AND user_id=? AND account_id=?")
    .bind(cursor, identity.userId, accountId).first<{ created_at: number }>() : null;
  if (cursor && !after) throw new HttpError(400, "invalid_cursor");
  const { results } = await env.DB.prepare(`SELECT * FROM normal_outgoing_messages WHERE user_id=? AND account_id=?
    ${after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
    .bind(identity.userId, accountId, ...(after ? [after.created_at, after.created_at, cursor] : []), limit + 1).all<NormalOutgoing>();
  const items = results.slice(0, limit);
  return json({ items: items.map(row => normalOutgoingView(row, false)), nextCursor: results.length > limit ? items.at(-1)!.id : null });
}
export async function maintainNormalOutgoing(env: Env) {
  const now = unixNow();
  await env.DB.prepare(`UPDATE normal_outgoing_messages SET state='unknown',error_code='smtp_outcome_unknown',updated_at=?
    WHERE id IN (SELECT id FROM normal_outgoing_messages WHERE state='pending' AND created_at<=? LIMIT 5000)`).bind(now, now - 60).run();
  const { policy, revision } = await readRetention(env);
  if (!policy.enabled || !policy.outgoingDays) return;
  // Preserve the minimal guard, content hash and quota charge permanently; redact only content.
  await env.DB.prepare(`UPDATE normal_outgoing_messages SET content_purged_at=?,from_address='',to_address='',recipients_json=NULL,subject='',text_body='',reply_message_id=NULL,reply_threading=NULL,attachments_json=NULL
    WHERE id IN (SELECT id FROM normal_outgoing_messages WHERE state<>'pending' AND content_purged_at IS NULL AND updated_at<=? ORDER BY updated_at,id LIMIT 100)
    AND EXISTS (SELECT 1 FROM retention_policy WHERE id=1 AND revision=?)`).bind(now, now - policy.outgoingDays * 86400, revision).run();
}
