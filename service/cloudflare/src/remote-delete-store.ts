import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json } from "./http";
import type { RemoteDeleteState } from "./providers/contracts";

export interface RemoteDeletion {
  id: string; user_id: string; mailbox_id: string; message_id: string; provider_id: string; provider_revision: number; provider_endpoint: string;
  remote_id: string; source_version: string; request_key: string; request_hash: string;
  state: "pending" | "unknown" | RemoteDeleteState; error_code: string | null; created_at: number; updated_at: number;
}
export function deletionView(row: RemoteDeletion) {
  const stale = row.state === "pending" && row.created_at <= unixNow() - 60;
  return { id: row.id, messageId: row.message_id, mailboxId: row.mailbox_id, state: stale ? "unknown" : row.state,
    error: stale ? "remote_delete_outcome_unknown" : row.error_code, retrySafe: false, cacheRetained: true,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
export function deletionResponse(row: RemoteDeletion, hash?: string): Response {
  if (hash !== undefined && row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
  const view = deletionView(row);
  return json({ deletion: view }, ["pending", "unknown"].includes(view.state) ? 202 : 200);
}
export function deletionByKey(env: Env, identity: Identity, key: string) {
  return env.DB.prepare("SELECT * FROM remote_deletions WHERE user_id=? AND request_key=?")
    .bind(identity.userId, key).first<RemoteDeletion>();
}
export function deletionByMessage(env: Env, identity: Identity, mailboxId: string, messageId: string) {
  return env.DB.prepare("SELECT * FROM remote_deletions WHERE user_id=? AND mailbox_id=? AND message_id=?")
    .bind(identity.userId, mailboxId, messageId).first<RemoteDeletion>();
}
export async function finishDeletion(env: Env, row: RemoteDeletion, state: RemoteDeletion["state"], error: string | null) {
  try {
    // Terminal evidence cannot be replaced by a concurrent timeout or late status failure.
    await env.DB.prepare(`UPDATE remote_deletions SET state=?,error_code=?,updated_at=?
      WHERE id=? AND user_id=? AND state IN ('pending','unknown')${state === "unknown" ? " AND state='pending'" : ""}`)
      .bind(state, error, unixNow(), row.id, row.user_id).run();
    const saved = await env.DB.prepare("SELECT * FROM remote_deletions WHERE id=? AND user_id=?")
      .bind(row.id, row.user_id).first<RemoteDeletion>();
    if (!saved) throw new Error("reservation missing");
    return saved;
  } catch {
    // The durable reservation is retained even if recording the result fails.
    throw new HttpError(503, "remote_delete_storage_failed");
  }
}
