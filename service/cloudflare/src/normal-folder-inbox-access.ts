import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope, identityCredentialFence } from "./identity";
import { folderInboxTarget } from "./normal-folder-inbox-target";
import { normalInboxContext, assertNormalInboxCurrent, normalStoredMessage, type NormalInboxContext, type NormalStoredMessage } from "./normal-inbox-access";
import { normalStateColumns, normalStateJoin } from "./normal-message-state";
import type { InboxState } from "./normal-inbox-claim";

export const separateFolderInbox = (context: NormalInboxContext) => !!context.serverFolder && context.serverFolder.wireName.toUpperCase() !== "INBOX";
export async function folderInboxContext(env: Env, identity: Identity, accountId: string, folderId: string): Promise<NormalInboxContext> {
  requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read");
  const target = await folderInboxTarget(env, identity, accountId, folderId);
  if (target.wireName.toUpperCase() === "INBOX") return { ...await normalInboxContext(env, identity, accountId), serverFolder: target };
  const state = await env.DB.prepare("SELECT * FROM normal_server_folder_state WHERE account_id=? AND server_folder_id=? AND wire_name=?")
    .bind(accountId, folderId, target.wireName).first<InboxState>();
  const current = state?.source_hash === target.sourceHash;
  return { account: target.account, epochId: current ? state!.epoch_id : null, afterUid: current ? state!.after_uid : 0,
    cacheGeneration: state?.cache_generation ?? 0, serverFolder: target };
}
export async function assertFolderInboxCurrent(env: Env, identity: Identity, context: NormalInboxContext) {
  if (!context.serverFolder) return assertNormalInboxCurrent(env, identity, context);
  const actual = await folderInboxContext(env, identity, context.account.id, context.serverFolder.id);
  if (actual.account.revision !== context.account.revision || actual.epochId !== context.epochId || actual.cacheGeneration !== context.cacheGeneration
    || actual.serverFolder!.sourceHash !== context.serverFolder.sourceHash) throw new HttpError(409, "normal_account_changed");
  if (!await env.DB.prepare(`SELECT 1 WHERE ${identityCredentialFence(identity)}`).bind(identity.credentialId, identity.userId).first()) {
    throw new HttpError(401, "unauthorized");
  }
}
export async function folderStoredMessage(env: Env, context: NormalInboxContext, id: string) {
  if (!separateFolderInbox(context)) return normalStoredMessage(env, context, id);
  if (!context.epochId) throw new HttpError(404, "not_found");
  const row = await env.DB.prepare(`SELECT m.*,${normalStateColumns} FROM normal_inbox_messages m
    JOIN normal_inbox_batches b ON b.id=m.batch_id ${normalStateJoin}
    WHERE m.id=? AND m.account_id=? AND m.server_folder_id=? AND m.epoch_id=? AND m.purged_at IS NULL
    AND b.account_id=m.account_id AND b.server_folder_id=m.server_folder_id AND b.epoch_id=m.epoch_id AND b.source_hash=? AND b.status='committed'`)
    .bind(id, context.account.id, context.serverFolder!.id, context.epochId, context.serverFolder!.sourceHash).first<NormalStoredMessage>();
  if (!row) throw new HttpError(404, "not_found"); return row;
}
