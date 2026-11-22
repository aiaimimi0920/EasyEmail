import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { assertMailboxUsable } from "./mailbox-access";
import { ownedMailbox } from "./mailbox-sync";
import { decryptCredential } from "./mailbox-vault";
import { MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";
import { configuredProvider, connectProvider } from "./providers/registry";
import { assertProviderRevision, PROVIDER_REVISION_FENCE } from "./providers/settings";
import { tokenHash } from "./security";
import { rateLimit } from "./rate-limits";
import { deletionByKey, deletionByMessage, deletionResponse, finishDeletion, type RemoteDeletion } from "./remote-delete-store";

interface Source { remote_id: string; source_version: string | null; remote_delete_enabled: number; trashed_at: number | null; purged_at: number | null }
async function source(env: Env, identity: Identity, mailboxId: string, messageId: string) {
  const row = await env.DB.prepare(`SELECT remote_id,source_version,remote_delete_enabled,trashed_at,purged_at
    FROM messages WHERE id=? AND mailbox_id=? AND user_id=?`).bind(messageId, mailboxId, identity.userId).first<Source>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}
function assertSource(row: Source) {
  if (row.purged_at !== null) throw new HttpError(409, "message_purged");
  if (row.trashed_at === null) throw new HttpError(409, "message_not_trashed");
  if (!row.source_version || row.remote_delete_enabled !== 1 || !/^[0-9a-f]{32}$/.test(row.source_version)
    || !/^[1-9]\d{0,15}$/.test(row.remote_id) || !Number.isSafeInteger(Number(row.remote_id))) throw new HttpError(409, "remote_delete_unavailable");
}

export async function remoteDeletion(request: Request, env: Env, identity: Identity, mailboxId: string, messageId: string, check: boolean) {
  if (request.method === "GET" && !check) {
    requireScope(identity, "messages:read"); await source(env, identity, mailboxId, messageId);
    const row = await deletionByMessage(env, identity, mailboxId, messageId);
    return row ? deletionResponse(row) : json({ deletion: null });
  }
  requireWriteScope(request, env, identity, "messages:remote-delete");
  const body = await readJson(request);
  if (check && Object.keys(body).length) throw new HttpError(400, "invalid_remote_delete_request");
  if (!check && (Object.keys(body).length !== 2 || body.confirmMessageId !== messageId || typeof body.confirmAddress !== "string")) {
    throw new HttpError(400, "remote_delete_confirmation_required");
  }
  const mailbox = await ownedMailbox(env, identity, mailboxId);
  if (!check && body.confirmAddress !== mailbox.address) throw new HttpError(400, "remote_delete_confirmation_required");
  const key = request.headers.get("idempotency-key") ?? "";
  if (!check && !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  const hash = await tokenHash(JSON.stringify([mailboxId, messageId, mailbox.address]));
  const byKey = check ? null : await deletionByKey(env, identity, key);
  if (byKey) return deletionResponse(byKey, hash);
  let existing = await deletionByMessage(env, identity, mailboxId, messageId);
  if (existing && (!check || ["deleted", "absent", "changed"].includes(existing.state))) return deletionResponse(existing, hash);
  if (check && !existing) throw new HttpError(404, "remote_deletion_not_found");
  assertMailboxUsable(mailbox);
  const config = await configuredProvider(env, mailbox.provider_id);
  if (existing && (existing.provider_id !== config.id || existing.provider_revision !== config.revision || existing.provider_endpoint !== config.baseUrl)) {
    throw new HttpError(409, "provider_config_changed");
  }
  if (config.type !== "cloudflare") throw new HttpError(409, "remote_delete_unavailable");
  const provider = await connectProvider(env, config);
  if (!provider.remoteDelete) throw new HttpError(409, "remote_delete_unavailable");
  const credential = await decryptCredential(env, mailbox, mailbox.credential_cipher);
  if (!credential.token) throw new HttpError(503, "mailbox_credential_unavailable");
  await rateLimit(env, check ? "remote-delete-check" : "remote-delete", identity.userId, 20);
  if (!check) {
    const current = await source(env, identity, mailboxId, messageId); assertSource(current);
    const id = crypto.randomUUID(), now = unixNow();
    let reserved: D1Result;
    try {
      reserved = await env.DB.prepare(`INSERT INTO remote_deletions
        (id,user_id,mailbox_id,message_id,provider_id,provider_revision,provider_endpoint,remote_id,source_version,request_key,request_hash,state,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND user_id=?
          AND status='active' AND disabled_at IS NULL AND released_at IS NULL AND ${MAILBOX_EXPIRY_FENCE})
        AND EXISTS(SELECT 1 FROM messages WHERE id=? AND mailbox_id=? AND user_id=? AND trashed_at IS NOT NULL
          AND purged_at IS NULL AND remote_id=? AND source_version=? AND remote_delete_enabled=1) AND ${PROVIDER_REVISION_FENCE}
        ON CONFLICT DO NOTHING`)
        .bind(id, identity.userId, mailboxId, messageId, config.id, config.revision, config.baseUrl, current.remote_id, current.source_version,
          key, hash, now, now, mailboxId, identity.userId, messageId, mailboxId, identity.userId,
          current.remote_id, current.source_version, config.id, config.revision).run();
    } catch { throw new HttpError(503, "remote_delete_storage_failed"); }
    if (!reserved.meta.changes) {
      const duplicate = await deletionByKey(env, identity, key) ?? await deletionByMessage(env, identity, mailboxId, messageId);
      if (duplicate) return deletionResponse(duplicate, hash);
      await assertProviderRevision(env, config); assertMailboxUsable(await ownedMailbox(env, identity, mailboxId));
      assertSource(await source(env, identity, mailboxId, messageId)); throw new HttpError(409, "remote_delete_already_requested");
    }
    existing = { id, user_id: identity.userId, mailbox_id: mailboxId, message_id: messageId, provider_id: config.id,
      provider_revision: config.revision ?? 0, provider_endpoint: config.baseUrl, remote_id: current.remote_id, source_version: current.source_version!,
      request_key: key, request_hash: hash, state: "pending", error_code: null, created_at: now, updated_at: now };
  }
  const row = existing!;
  let state: RemoteDeletion["state"] = "unknown", errorCode: string | null = null;
  try { state = await provider.remoteDelete(credential, { requestId: row.id, mailId: row.remote_id, expectedVersion: row.source_version }, check); }
  catch (error) { errorCode = error instanceof HttpError ? error.code : "remote_delete_outcome_unknown"; }
  return deletionResponse(await finishDeletion(env, row, state, errorCode));
}
