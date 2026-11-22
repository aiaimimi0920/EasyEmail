import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { normalAccount } from "./normal-account-store";
import { syncNormalInbox } from "./normal-inbox-sync";
import { inboxAccountFence } from "./normal-inbox-claim";
import { requireScope } from "./identity";
import { rateLimit } from "./rate-limits";
import { NORMAL_INBOX_CAPACITY } from "./normal-inbox-capacity";
import type { ReceiveFence } from "./normal-folder-inbox-target";
import { normalReceiveLeaseTable } from "./normal-retention-selection";

interface SyncRequest {
  id: string; account_id: string; request_key: string; account_revision: number; created_at: number; finished_at: number | null; error_code: string | null;
  batch_id: string | null; status: string | null; epoch_id: string; uid_validity: string; after_uid: number;
  reset: number; complete: number; manifest: string; item_count: number; committed_at: number; current_revision: number;
  active_request: string | null; active_lease: number | null;
}
const query = `SELECT r.*,b.id AS batch_id,b.status,b.epoch_id,b.uid_validity,b.after_uid,b.reset,b.complete,b.manifest,b.item_count,b.committed_at,
  a.revision AS current_revision,s.request_id AS active_request,s.claim_lease_until AS active_lease
  FROM normal_inbox_requests r JOIN normal_accounts a ON a.id=r.account_id JOIN users u ON u.id=a.user_id
  LEFT JOIN normal_inbox_state s ON s.account_id=a.id
  LEFT JOIN normal_inbox_batches b ON b.request_id=r.id WHERE a.id=? AND a.user_id=? AND a.deleted_at IS NULL AND u.status='active'`;
function view(row: SyncRequest) {
  const now = Math.floor(Date.now() / 1000), live = row.active_request === row.id && (row.active_lease ?? 0) > now;
  const committed = row.status === "committed", expired = !live && row.created_at + 90 <= now;
  const state = committed ? "committed" : row.finished_at !== null || expired || row.current_revision !== row.account_revision ? "failed" : "pending";
  const manifest = committed ? JSON.parse(row.manifest) as { items: unknown[]; skipped: unknown[] } : null;
  return { id: row.id, accountId: row.account_id, requestKey: row.request_key, accountRevision: row.account_revision, state, createdAt: row.created_at,
    finishedAt: committed ? row.committed_at : row.finished_at,
    errorCode: committed ? null : row.error_code ?? (state === "failed" ? "normal_sync_interrupted" : null),
    result: manifest ? { batchId: row.batch_id, accountRevision: row.account_revision, epochId: row.epoch_id,
      cursor: { uidValidity: row.uid_validity, afterUid: row.after_uid }, stored: row.item_count,
      skipped: manifest.skipped, reset: !!row.reset, complete: !!row.complete } : null };
}
export async function getNormalSyncRequest(env: Env, identity: Identity, accountId: string, key: string) {
  const row = await env.DB.prepare(`${query} AND r.request_key=?`).bind(accountId, identity.userId, key).first<SyncRequest>();
  if (!row) throw new HttpError(404, "not_found"); return view(row);
}
export async function listNormalSyncRequests(env: Env, identity: Identity, accountId: string) {
  const account = await normalAccount(env, identity.userId, accountId);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  const { results } = await env.DB.prepare(`${query} ORDER BY r.created_at DESC,r.id DESC LIMIT 20`).bind(accountId, identity.userId).all<SyncRequest>();
  return { items: results.map(view) };
}
async function replay(env: Env, identity: Identity, accountId: string, revision: number, key: string) {
  const previous = await getNormalSyncRequest(env, identity, accountId, key).catch(error => {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  });
  if (previous && previous.accountRevision !== revision) throw new HttpError(409, "idempotency_conflict");
  return previous;
}
export async function requestNormalSync(env: Env, identity: Identity, accountId: string, revision: number, key: string, receiveFence?: ReceiveFence) {
  requireScope(identity, "mail-accounts:sync");
  const account = await normalAccount(env, identity.userId, accountId);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  const folderSchema = await normalReceiveLeaseTable(env) === "normal_receive_leases";
  if (folderSchema && await env.DB.prepare(
    "SELECT 1 FROM normal_server_folder_sync_requests WHERE account_id=? AND request_key=?").bind(accountId, key).first()) throw new HttpError(409, "idempotency_conflict");
  const previous = await replay(env, identity, accountId, revision, key);
  if (previous) return previous;
  if (account.revision !== revision) throw new HttpError(409, "normal_account_changed");
  if (!account.enabled) throw new HttpError(409, "normal_account_disabled");
  const id = crypto.randomUUID();
  let inserted;
  try {
    // Separate from transport limits: even missing configuration must not grow durable failed receipts without bound per minute.
    await rateLimit(env, "normal-inbox-request", identity.userId, 10);
    await rateLimit(env, "normal-inbox-request-global", "platform", 60);
    inserted = await env.DB.prepare(`INSERT INTO normal_inbox_requests(id,account_id,request_key,account_revision,created_at)
      SELECT ?,?,?,?,unixepoch() WHERE ${inboxAccountFence} AND ${NORMAL_INBOX_CAPACITY}
      ${folderSchema ? "AND NOT EXISTS (SELECT 1 FROM normal_server_folder_sync_requests WHERE account_id=? AND request_key=?)" : ""}
      ON CONFLICT(account_id,request_key) DO NOTHING`)
      .bind(id, accountId, key, revision, accountId, identity.userId, revision, accountId, 1, 1, ...(folderSchema ? [accountId, key] : [])).run();
  } catch (error) {
    // Admission races and an ambiguous INSERT response may already have an original guard. Never reconnect on that path.
    const raced = await replay(env, identity, accountId, revision, key);
    if (raced) return raced;
    throw error;
  }
  if (!inserted.meta.changes) {
    const raced = await replay(env, identity, accountId, revision, key);
    if (raced) return raced;
    throw new HttpError(409, "normal_inbox_changed_or_limit");
  }
  try { await syncNormalInbox(env, identity, accountId, revision, id, receiveFence); }
  catch (error) {
    const code = error instanceof HttpError ? error.code : "normal_inbox_storage_failed";
    await env.DB.prepare(`UPDATE normal_inbox_requests SET finished_at=unixepoch(),error_code=? WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM normal_inbox_batches WHERE request_id=? AND status='committed')`).bind(code, id, id).run();
  }
  return getNormalSyncRequest(env, identity, accountId, key);
}
