import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireMailWrite } from "./mailbox-create";
import { decryptCredential } from "./mailbox-vault";
import { configuredProvider, connectProvider } from "./providers/registry";
import { rateLimit } from "./rate-limits";
import { mailCacheStatements } from "./mail-cache";
import { assertMailboxUsable } from "./mailbox-access";
import { assertProviderRevision, PROVIDER_REVISION_FENCE } from "./providers/settings";
import { MAILBOX_QUOTAS } from "./quota-policy";
import { MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";
import { providerCursorStatement, providerSyncCursor } from "./provider-sync-cursor";
import { mailboxSessionCheckpoint } from "./mailbox-session-checkpoint";

export interface OwnedMailbox {
  id: string; user_id: string; provider_id: string; remote_id: string; address: string; status: string;
  credential_cipher: string | null; synced_at: number | null; sync_error: string | null; next_page: number | null;
  sync_revision: number; sync_missing: number;
  paused: number;
  disabled_at: number | null; released_at: number | null;
  expires_at: number | null; expired_at: number | null;
}

export async function ownedMailbox(env: Env, identity: Identity, id: string): Promise<OwnedMailbox> {
  const row = await env.DB.prepare(`SELECT id, user_id, provider_id, remote_id, address, status, credential_cipher,
    synced_at, sync_error, next_page, sync_revision, sync_missing, paused, disabled_at, released_at, expires_at, expired_at FROM mailboxes WHERE id = ? AND user_id = ?`)
    .bind(id, identity.userId).first<OwnedMailbox>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

export async function syncMailbox(request: Request, env: Env, identity: Identity, id: string): Promise<Response> {
  requireMailWrite(request, env, identity);
  const body = await readJson(request);
  return json({ sync: await syncMailboxPage(env, identity, id, body.page ?? 1) });
}

// Callers authorize the operation before entering the shared lease/rate/cache boundary.
export async function syncMailboxPage(env: Env, identity: Identity, id: string, page: unknown = 1) {
  const row = await ownedMailbox(env, identity, id);
  assertMailboxUsable(row);
  if (row.paused) throw new HttpError(409, "mailbox_paused");
  if (!Number.isSafeInteger(page) || (page as number) < 1 || (page as number) > 1000
    || (page !== 1 && page !== row.next_page)) throw new HttpError(400, "invalid_sync_page");
  await rateLimit(env, "mailbox-sync", identity.userId, MAILBOX_QUOTAS.syncRequestsPerMinute);
  const config = await configuredProvider(env, row.provider_id);
  const provider = await connectProvider(env, config);
  const credential = await decryptCredential(env, row, row.credential_cipher);
  const lease = crypto.randomUUID();
  const acquired = await env.DB.prepare(`UPDATE mailboxes SET sync_token = ?, sync_lease_until = ?
    WHERE id = ? AND user_id = ? AND status = 'active' AND disabled_at IS NULL AND released_at IS NULL
    AND paused = 0 AND sync_revision = ? AND (sync_lease_until IS NULL OR sync_lease_until <= ?)
    AND ${PROVIDER_REVISION_FENCE} AND ${MAILBOX_EXPIRY_FENCE}`)
    .bind(lease, unixNow() + 45, id, identity.userId, row.sync_revision, unixNow(), config.id, config.revision).run();
  if (!acquired.meta.changes) {
    assertMailboxUsable(await ownedMailbox(env, identity, id));
    await assertProviderRevision(env, config);
    throw new HttpError(409, "sync_in_progress");
  }
  try {
    const cursor = provider.cursorPaging ? await providerSyncCursor(env, row, page as number) : undefined;
    const result = await provider.read(row.address, credential, page as number, cursor, mailboxSessionCheckpoint(env, row, config, lease));
    const missing = (page === 1 ? 0 : row.sync_missing) + result.missing;
    const cache = await Promise.all(result.items.map((mail) => mailCacheStatements(env, row, mail, lease)));
    const statements = cache.flat();
    let offset = 0;
    const insertedIndexes = cache.map(batch => { const index = offset + 1; offset += batch.length; return index; });
    if (provider.cursorPaging) statements.push(providerCursorStatement(env, row, result, page as number, lease));
    statements.push(env.DB.prepare(`UPDATE mailboxes SET synced_at = ?, sync_error = ?, next_page = ?, sync_missing = ?,
      sync_revision = sync_revision + 1,
      sync_token = NULL, sync_lease_until = NULL WHERE id = ? AND user_id = ? AND status = 'active'
      AND disabled_at IS NULL AND released_at IS NULL AND paused = 0 AND sync_token = ? AND sync_lease_until > unixepoch() AND ${MAILBOX_EXPIRY_FENCE}`)
      .bind(unixNow(), missing ? "upstream_messages_missing" : null, result.nextPage, missing, id, identity.userId, lease));
    const writes = await env.DB.batch(statements);
    if (!writes.at(-1)!.meta.changes) throw new HttpError(409, "sync_lease_lost");
    return { syncedAt: unixNow(), fetched: result.items.length,
      inserted: insertedIndexes.reduce((n, index) => n + writes[index].meta.changes, 0),
      nextPage: result.nextPage, complete: result.nextPage === null && missing === 0, missing };
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "sync_storage_failed";
    await env.DB.prepare(`UPDATE mailboxes SET sync_error = ?, sync_token = NULL, sync_lease_until = NULL
      WHERE id = ? AND user_id = ? AND sync_token = ?`).bind(code, id, identity.userId, lease).run();
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, code);
  }
}
