import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope, identityCredentialFence } from "./identity";
import { folderInboxTarget, folderInboxMembership, type FolderInboxTarget } from "./normal-folder-inbox-target";
import { inboxAccountFence } from "./normal-inbox-claim";
import { NORMAL_INBOX_CAPACITY } from "./normal-inbox-capacity";
import { syncFolderInbox } from "./normal-folder-inbox-sync";
import { getNormalSyncRequest, listNormalSyncRequests, requestNormalSync } from "./normal-sync-requests";
import { rateLimit } from "./rate-limits";
import { serverFolderAccount, serverFolderSource } from "./normal-server-folder-store";
import { tokenHash } from "./security";

interface FolderRequest {
  id: string; account_id: string; server_folder_id: string; request_key: string; account_revision: number; created_at: number;
  finished_at: number | null; error_code: string | null; current_revision: number; batch_id: string | null;
  status: string | null; epoch_id: string; uid_validity: string; after_uid: number; reset: number; complete: number;
  manifest: string; item_count: number; committed_at: number; active_request: string | null; active_lease: number | null;
}
const query = `SELECT r.*,a.revision AS current_revision,b.id AS batch_id,b.status,b.epoch_id,b.uid_validity,b.after_uid,
  b.reset,b.complete,b.manifest,b.item_count,b.committed_at,s.request_id AS active_request,s.claim_lease_until AS active_lease
  FROM normal_server_folder_sync_requests r JOIN normal_accounts a ON a.id=r.account_id JOIN users u ON u.id=a.user_id
  LEFT JOIN normal_server_folder_state s ON s.account_id=r.account_id AND s.server_folder_id=r.server_folder_id
  LEFT JOIN normal_inbox_batches b ON b.server_request_id=r.id AND b.server_folder_id=r.server_folder_id
  WHERE a.id=? AND a.user_id=? AND a.deleted_at IS NULL AND u.status='active'`;
function view(row: FolderRequest) {
  const live = row.active_request === row.id && (row.active_lease ?? 0) > Date.now() / 1000;
  const committed = row.status === "committed";
  const failed = row.finished_at !== null || (!live && row.created_at + 90 <= Date.now() / 1000) || row.current_revision !== row.account_revision;
  const state = committed ? "committed" : failed ? "failed" : "pending";
  const manifest = committed ? JSON.parse(row.manifest) as { skipped: unknown[] } : null;
  return { id: row.id, accountId: row.account_id, serverFolderId: row.server_folder_id, requestKey: row.request_key, accountRevision: row.account_revision,
    state, createdAt: row.created_at, finishedAt: committed ? row.committed_at : row.finished_at,
    errorCode: committed ? null : row.error_code ?? (failed ? "normal_sync_interrupted" : null),
    result: manifest ? { batchId: row.batch_id, accountRevision: row.account_revision, epochId: row.epoch_id,
      cursor: { uidValidity: row.uid_validity, afterUid: row.after_uid }, stored: row.item_count,
      skipped: manifest.skipped, reset: !!row.reset, complete: !!row.complete } : null };
}
async function find(env: Env, identity: Identity, accountId: string, folderId: string, key: string) {
  const row = await env.DB.prepare(`${query} AND r.request_key=?`).bind(accountId, identity.userId, key).first<FolderRequest>();
  if (row && row.server_folder_id !== folderId) throw new HttpError(409, "idempotency_conflict");
  return row ? view(row) : null;
}
export async function getFolderSyncRequest(env: Env, identity: Identity, accountId: string, folderId: string, key: string) {
  const account = await serverFolderAccount(env, identity, accountId), row = await find(env, identity, accountId, folderId, key);
  if (row) return row;
  const inboxId = await tokenHash(JSON.stringify(["normal-server-folder-v1", accountId, await serverFolderSource(account), "INBOX"]));
  if (folderId === inboxId) return { ...await getNormalSyncRequest(env, identity, accountId, key), serverFolderId: folderId };
  if (!row) throw new HttpError(404, "not_found"); return row;
}
export async function listFolderSyncRequests(env: Env, identity: Identity, accountId: string, folderId: string) {
  const account = await serverFolderAccount(env, identity, accountId);
  const inboxId = await tokenHash(JSON.stringify(["normal-server-folder-v1", accountId, await serverFolderSource(account), "INBOX"]));
  if (folderId === inboxId) {
    const result = await listNormalSyncRequests(env, identity, accountId);
    return { items: result.items.map(row => ({ ...row, serverFolderId: folderId })) };
  }
  const rows = await env.DB.prepare(`${query} AND r.server_folder_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 20`)
    .bind(accountId, identity.userId, folderId).all<FolderRequest>();
  return { items: rows.results.map(view) };
}
export async function requestFolderSync(env: Env, identity: Identity, accountId: string, folderId: string, revision: number, key: string) {
  requireScope(identity, "mail-accounts:sync");
  const target = await folderInboxTarget(env, identity, accountId, folderId), account = target.account;
  if (target.wireName.toUpperCase() === "INBOX") {
    const membership = folderInboxMembership(target);
    return { ...await requestNormalSync(env, identity, accountId, revision, key, {
      sql: `${membership.sql} AND ${identityCredentialFence(identity)}`, values: [...membership.values, identity.credentialId, identity.userId],
    }), serverFolderId: folderId };
  }
  if (await env.DB.prepare("SELECT 1 FROM normal_inbox_requests WHERE account_id=? AND request_key=?").bind(accountId, key).first()) {
    throw new HttpError(409, "idempotency_conflict");
  }
  const replay = async () => {
    const previous = await find(env, identity, accountId, folderId, key);
    if (previous && previous.accountRevision !== revision) throw new HttpError(409, "idempotency_conflict");
    return previous;
  };
  const previous = await replay(); if (previous) return previous;
  if (account.revision !== revision) throw new HttpError(409, "normal_account_changed");
  if (!account.enabled) throw new HttpError(409, "normal_account_disabled");
  const id = crypto.randomUUID(), membership = folderInboxMembership(target);
  let inserted;
  try {
    await rateLimit(env, "normal-inbox-request", identity.userId, 10);
    await rateLimit(env, "normal-inbox-request-global", "platform", 60);
    inserted = await env.DB.prepare(`INSERT INTO normal_server_folder_sync_requests
      (id,account_id,server_folder_id,request_key,account_revision,created_at) SELECT ?,?,?,?,?,unixepoch()
      WHERE ${inboxAccountFence} AND ${membership.sql} AND ${identityCredentialFence(identity)} AND ${NORMAL_INBOX_CAPACITY}
      AND NOT EXISTS (SELECT 1 FROM normal_inbox_requests WHERE account_id=? AND request_key=?)
      AND (SELECT COUNT(*) FROM normal_server_folder_sync_requests WHERE account_id=?)<10000
      ON CONFLICT(account_id,request_key) DO NOTHING`)
      .bind(id, accountId, folderId, key, revision, accountId, identity.userId, revision, ...membership.values,
        identity.credentialId, identity.userId, accountId, 1, 1, accountId, key, accountId).run();
  } catch (error) { const raced = await replay(); if (raced) return raced; throw error; }
  if (!inserted.meta.changes) {
    const raced = await replay(); if (raced) return raced;
    throw new HttpError(409, "normal_inbox_changed_or_limit");
  }
  try { await syncFolderInbox(env, identity, target, id); }
  catch (error) {
    await env.DB.prepare(`UPDATE normal_server_folder_sync_requests SET finished_at=unixepoch(),error_code=? WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM normal_inbox_batches WHERE server_request_id=? AND status='committed')`)
      .bind(error instanceof HttpError ? error.code : "normal_inbox_storage_failed", id, id).run();
  }
  return getFolderSyncRequest(env, identity, accountId, folderId, key);
}
