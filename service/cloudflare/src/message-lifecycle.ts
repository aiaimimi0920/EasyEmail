import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireWriteScope } from "./identity";
import { MESSAGE_CONTENT_RESET } from "./message-tombstone";

export async function messageLifecycle(request: Request, env: Env, identity: Identity,
  mailboxId: string, id: string, action: "trash" | "restore" | "purge"): Promise<Response> {
  requireWriteScope(request, env, identity, "messages:delete");
  const body = action === "trash" ? {} : await readJson(request);
  if (action === "purge" && (body.confirmMessageId !== id || Object.keys(body).length !== 1)) throw new HttpError(400, "purge_confirmation_required");
  if (action === "restore" && Object.keys(body).length) throw new HttpError(400, "invalid_lifecycle_request");
  const current = await env.DB.prepare("SELECT trashed_at, purged_at FROM messages WHERE id = ? AND mailbox_id = ? AND user_id = ?")
    .bind(id, mailboxId, identity.userId).first<{ trashed_at: number | null; purged_at: number | null }>();
  if (!current) throw new HttpError(404, "not_found");
  if (action === "restore" && current.purged_at !== null) throw new HttpError(409, "message_purged");
  if (action === "purge" && current.trashed_at === null) throw new HttpError(409, "message_not_trashed");
  const assignments = action === "trash" ? "trashed_at = COALESCE(trashed_at, ?)"
    : action === "restore" ? "trashed_at = NULL" : `purged_at = COALESCE(purged_at, ?), ${MESSAGE_CONTENT_RESET}`;
  const condition = action === "restore" ? "purged_at IS NULL" : action === "purge" ? "trashed_at IS NOT NULL" : "1";
  const update = env.DB.prepare(`UPDATE messages SET ${assignments}
    WHERE id = ? AND mailbox_id = ? AND user_id = ? AND ${condition} RETURNING id, trashed_at, purged_at`)
    .bind(...(action === "restore" ? [] : [unixNow()]), id, mailboxId, identity.userId);
  const writes = await env.DB.batch([update, ...(action === "purge" ? [env.DB.prepare(`DELETE FROM message_thread_links
    WHERE user_id=? AND mailbox_id=? AND message_id=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND user_id=? AND purged_at IS NOT NULL)`)
    .bind(identity.userId, mailboxId, id, id, identity.userId), env.DB.prepare(`DELETE FROM message_subscriptions WHERE user_id=? AND mailbox_id=? AND message_id=?
      AND EXISTS(SELECT 1 FROM messages WHERE id=? AND user_id=? AND purged_at IS NOT NULL)`)
      .bind(identity.userId, mailboxId, id, id, identity.userId)] : [])]);
  const row = writes[0].results[0] as { id: string; trashed_at: number | null; purged_at: number | null } | undefined;
  if (!row) throw new HttpError(409, action === "restore" ? "message_purged" : "message_not_trashed");
  return json({ lifecycle: { id: row.id, trashedAt: row.trashed_at, purgedAt: row.purged_at, upstreamChanged: false } });
}
