import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json } from "./http";
import type { RemoteDeleteState } from "./providers/contracts";
import type { ProviderConfig } from "./providers/contracts";
import type { OwnedMailbox } from "./mailbox-sync";
import { MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";
import { PROVIDER_REVISION_FENCE } from "./providers/settings";

export interface MailboxDeletion {
  id: string; user_id: string; mailbox_id: string; provider_id: string; provider_revision: number; provider_endpoint: string;
  remote_id: string; address: string; request_key: string; request_hash: string;
  state: "pending" | "unknown" | RemoteDeleteState; error_code: string | null; created_at: number; updated_at: number;
}
export function mailboxDeletionResponse(row: MailboxDeletion, hash?: string) {
  if (hash !== undefined && row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
  const stale = row.state === "pending" && row.created_at <= unixNow() - 60;
  const state = stale ? "unknown" : row.state;
  return json({ deletion: { id: row.id, mailboxId: row.mailbox_id, state, error: stale ? "remote_mailbox_delete_outcome_unknown" : row.error_code,
    retrySafe: false, cacheRetained: true, cleanup: "d1-mailbox-data-v1", externalResourcesDeleted: false,
    createdAt: row.created_at, updatedAt: row.updated_at } }, ["pending", "unknown"].includes(state) ? 202 : 200);
}
export function mailboxDeletionByKey(env: Env, identity: Identity, key: string) {
  return env.DB.prepare("SELECT * FROM remote_mailbox_deletions WHERE user_id=? AND request_key=?")
    .bind(identity.userId, key).first<MailboxDeletion>();
}
export function mailboxDeletionByMailbox(env: Env, identity: Identity, id: string) {
  return env.DB.prepare("SELECT * FROM remote_mailbox_deletions WHERE user_id=? AND mailbox_id=?")
    .bind(identity.userId, id).first<MailboxDeletion>();
}
const QUIESCENT = `NOT EXISTS(SELECT 1 FROM outgoing_messages WHERE mailbox_id=mailboxes.id AND state IN ('pending','unknown'))
  AND NOT EXISTS(SELECT 1 FROM remote_deletions WHERE mailbox_id=mailboxes.id AND state IN ('pending','unknown'))
  AND NOT EXISTS(SELECT 1 FROM send_jobs WHERE mailbox_id=mailboxes.id AND state IN ('queued','preparing'))`;

export async function assertMailboxQuiescent(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT id FROM mailboxes WHERE id=? AND ${QUIESCENT}`).bind(id).first();
  if (!row) throw new HttpError(409, "mailbox_external_operation_unresolved");
}
export async function reserveMailboxDeletion(env: Env, identity: Identity, box: OwnedMailbox, config: ProviderConfig, key: string, hash: string) {
  const id = crypto.randomUUID(), now = unixNow();
  const row: MailboxDeletion = { id, user_id: identity.userId, mailbox_id: box.id, provider_id: config.id, provider_revision: config.revision ?? 0,
    provider_endpoint: config.baseUrl, remote_id: box.remote_id, address: box.address, request_key: key, request_hash: hash,
    state: "pending", error_code: null, created_at: now, updated_at: now };
  try {
    const result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO remote_mailbox_deletions
        (id,user_id,mailbox_id,provider_id,provider_revision,provider_endpoint,remote_id,address,request_key,request_hash,state,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND user_id=?
          AND status='active' AND released_at IS NULL AND credential_cipher=? AND remote_id=? AND address=? AND sync_revision=?
          AND ${MAILBOX_EXPIRY_FENCE} AND ${QUIESCENT}) AND ${PROVIDER_REVISION_FENCE} ON CONFLICT DO NOTHING`)
        .bind(id, identity.userId, box.id, config.id, config.revision, config.baseUrl, box.remote_id, box.address, key, hash, now, now,
          box.id, identity.userId, box.credential_cipher, box.remote_id, box.address, box.sync_revision, config.id, config.revision),
      env.DB.prepare(`UPDATE mailboxes SET disabled_at=COALESCE(disabled_at,?),sync_token=NULL,sync_lease_until=NULL,sync_revision=sync_revision+1
        WHERE id=? AND user_id=? AND EXISTS(SELECT 1 FROM remote_mailbox_deletions WHERE id=? AND mailbox_id=mailboxes.id AND state='pending')`)
        .bind(now, box.id, identity.userId, id),
    ]);
    if (result[0].meta.changes && result[1].meta.changes !== 1) throw new Error("mailbox fence missing");
    return result[0].meta.changes ? row : null;
  } catch { throw new HttpError(503, "remote_mailbox_delete_storage_failed"); }
}
export async function finishMailboxDeletion(env: Env, row: MailboxDeletion, state: MailboxDeletion["state"], error: string | null) {
  try {
    // The durable result and credential release must commit together. A late timeout cannot regress terminal evidence.
    await env.DB.batch([
      env.DB.prepare(`UPDATE remote_mailbox_deletions SET state=?,error_code=?,updated_at=?
        WHERE id=? AND user_id=? AND state IN ('pending','unknown')${state === "unknown" ? " AND state='pending'" : ""}`)
        .bind(state, error, unixNow(), row.id, row.user_id),
      env.DB.prepare(`UPDATE mailboxes SET released_at=COALESCE(released_at,?),disabled_at=COALESCE(disabled_at,?),credential_cipher=NULL,
        sync_token=NULL,sync_lease_until=NULL,sync_revision=sync_revision+1 WHERE id=? AND user_id=?
        AND (released_at IS NULL OR credential_cipher IS NOT NULL)
        AND EXISTS(SELECT 1 FROM remote_mailbox_deletions WHERE id=? AND mailbox_id=mailboxes.id AND state IN ('deleted','absent','changed'))`)
        .bind(unixNow(), unixNow(), row.mailbox_id, row.user_id, row.id),
    ]);
    const saved = await env.DB.prepare("SELECT * FROM remote_mailbox_deletions WHERE id=? AND user_id=?").bind(row.id, row.user_id).first<MailboxDeletion>();
    if (!saved) throw new Error("reservation missing"); return saved;
  } catch { throw new HttpError(503, "remote_mailbox_delete_storage_failed"); }
}
