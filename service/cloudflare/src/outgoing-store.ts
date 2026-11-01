import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, pageOptions } from "./http";
import { requireScope } from "./identity";
import { storedRecipients } from "./outgoing-recipients";
import { storedOutbox } from "./outbox-references";

export interface OutgoingRow {
  id: string; user_id: string; mailbox_id: string; request_key: string; request_hash: string;
  provider_id: string; transport: "worker" | "binding"; from_address: string; to_address: string;
  subject: string; text_body: string; reply_message_id: string | null; threading: string;
  state: "pending" | "accepted" | "rejected" | "unknown"; error_code: string | null;
  created_at: number; updated_at: number;
  content_purged_at?: number | null; recipients_json?: string | null; recipient_count?: number;
  attachments_json?: string | null;
}

export function outgoingView(row: OutgoingRow, detail = true) {
  const stale = row.state === "pending" && row.created_at <= unixNow() - 60;
  return { id: row.id, mailboxId: row.mailbox_id, requestKey: row.request_key, providerId: row.provider_id,
    from: row.from_address, ...storedRecipients(row), attachments: storedOutbox(row), subject: row.subject, ...(detail ? { text: row.text_body } : {}),
    replyToMessageId: row.reply_message_id,
    threading: row.threading === "submitted" && row.state !== "accepted" ? "unconfirmed" : row.threading,
    state: stale ? "unknown" : row.state, error: stale ? "send_outcome_unknown" : row.error_code,
    retrySafe: false, delivery: "unconfirmed", createdAt: row.created_at, updatedAt: row.updated_at,
    contentPurgedAt: row.content_purged_at ?? null };
}

export async function outgoingByKey(env: Env, identity: Identity, key: string): Promise<OutgoingRow | null> {
  return env.DB.prepare("SELECT * FROM outgoing_messages WHERE user_id = ? AND request_key = ?")
    .bind(identity.userId, key).first<OutgoingRow>();
}

export function replayOutgoing(row: OutgoingRow, hash: string, initial = false): Response {
  if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
  const view = outgoingView(row);
  return json({ outgoing: view }, ["pending", "unknown"].includes(view.state) ? 202 : initial && row.state === "accepted" ? 201 : 200);
}

export async function getOutgoing(env: Env, identity: Identity, id: string): Promise<Response> {
  requireScope(identity, "messages:read");
  const row = await env.DB.prepare("SELECT * FROM outgoing_messages WHERE user_id = ? AND id = ?")
    .bind(identity.userId, id).first<OutgoingRow>();
  if (!row) throw new HttpError(404, "not_found");
  return json({ outgoing: outgoingView(row) });
}

export async function listOutgoing(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireScope(identity, "messages:read");
  const { limit, cursor } = pageOptions(new URL(request.url));
  const after = cursor ? await env.DB.prepare("SELECT created_at FROM outgoing_messages WHERE user_id = ? AND id = ?")
    .bind(identity.userId, cursor).first<{ created_at: number }>() : null;
  if (cursor && !after) throw new HttpError(400, "invalid_cursor");
  const { results } = await env.DB.prepare(`SELECT * FROM outgoing_messages WHERE user_id = ?
    ${after ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(identity.userId, ...(after ? [after.created_at, after.created_at, cursor] : []), limit + 1).all<OutgoingRow>();
  const items = results.slice(0, limit);
  return json({ items: items.map((row) => outgoingView(row, false)), nextCursor: results.length > limit ? items.at(-1)!.id : null });
}

export async function expirePendingSends(env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE outgoing_messages SET state = 'unknown', error_code = 'send_outcome_unknown', updated_at = ?
    WHERE id IN (SELECT id FROM outgoing_messages WHERE state = 'pending' AND created_at <= ? LIMIT 5000)`)
    .bind(unixNow(), unixNow() - 60).run();
}
