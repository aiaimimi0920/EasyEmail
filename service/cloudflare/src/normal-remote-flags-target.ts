import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { normalInboxContext, normalStoredMessage, type NormalInboxContext } from "./normal-inbox-access";
import { folderInboxContext, separateFolderInbox, folderStoredMessage } from "./normal-folder-inbox-access";
import { normalSearchJoin, normalSearchVisible, type NormalSearchContext } from "./normal-search-context";
import type { RemoteFlagOperation } from "./normal-remote-flags-store";

export async function remoteFlagContext(env: Env, identity: Identity, accountId: string, folderId: string) {
  const context = folderId ? await folderInboxContext(env, identity, accountId, folderId) : await normalInboxContext(env, identity, accountId);
  // INBOX retains one namespace and its original request hash, even when the catalog exposes an INBOX alias.
  if (folderId && !separateFolderInbox(context)) throw new HttpError(404, "not_found");
  return context;
}
export async function remoteFlagMessage(env: Env, context: NormalInboxContext, messageId: string) {
  const row = context.serverFolder ? await folderStoredMessage(env, context, messageId) : await normalStoredMessage(env, context, messageId);
  if (((row as typeof row & { server_folder_id?: string | null }).server_folder_id ?? "") !== (context.serverFolder?.id ?? "")) {
    throw new HttpError(404, "not_found");
  }
  return row;
}
export type RemoteMessageTarget = Pick<RemoteFlagOperation, "account_id" | "account_revision" | "epoch_id" | "source_hash" | "cache_generation"
  | "server_folder_id" | "server_wire_name" | "catalog_source" | "user_id" | "message_id" | "uid_validity" | "uid">;
export async function remoteFlagTargetFence(env: Env, row: RemoteMessageTarget) {
  const expanded = !!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='normal_server_folder_state'").first();
  if (row.server_folder_id && !expanded) return { sql: "0", values: [] };
  const context: NormalSearchContext = { id: row.account_id, revision: row.account_revision, epochId: row.epoch_id,
    sourceHash: row.source_hash, cacheGeneration: row.cache_generation, ...(expanded ? { folderSchema: true } : {}),
    ...(row.server_folder_id ? { serverFolderId: row.server_folder_id, wireName: row.server_wire_name!, catalogSource: row.catalog_source! } : {}) };
  const watermark = expanded ? "COALESCE(fs.after_uid,s.after_uid,0)" : "s.after_uid";
  const validity = row.server_folder_id ? "fs.uid_validity" : "s.uid_validity";
  return { sql: `EXISTS (SELECT 1 FROM normal_inbox_messages m ${normalSearchJoin([context])}
    WHERE ${normalSearchVisible} AND a.enabled=1 AND m.id=? AND m.uid_validity=? AND ${validity}=m.uid_validity AND m.uid=? AND m.uid<=${watermark})`,
    values: [JSON.stringify([context]), row.user_id, row.message_id, row.uid_validity, row.uid] };
}
export const remoteFlagFolderSchema = async (env: Env) => !!await env.DB.prepare(
  "SELECT 1 FROM pragma_table_info('normal_remote_flag_operations') WHERE name='catalog_source'").first();
