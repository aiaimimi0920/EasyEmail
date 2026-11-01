import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import type { NormalAccount } from "./normal-account-model";
import { normalInboxSourceHash } from "./normal-inbox-claim";
import { serverFolderSource } from "./normal-server-folder-store";
import { tokenHash } from "./security";
import type { ImapFolder } from "./normal-imap-folders";

export interface NormalSearchContext {
  id: string; revision: number; epochId: string; sourceHash: string; cacheGeneration: number;
  folderSchema?: true; serverFolderId?: string; serverFolderName?: string; wireName?: string; catalogSource?: string;
}
export type NormalSearchScope = "all" | "inbox";
interface SearchAccount extends NormalAccount { source_hash: string | null; epoch_id: string | null; cache_generation: number }
interface SearchFolder {
  account_id: string; server_folder_id: string; wire_name: string; source_hash: string; epoch_id: string;
  cache_generation: number; catalog_source: string; folder: string;
}
export async function normalSearchContexts(env: Env, identity: Identity, accountId = "", scope: NormalSearchScope = "all") {
  const rows = (await env.DB.prepare(`SELECT a.*,s.source_hash,s.epoch_id,s.cache_generation FROM normal_accounts a JOIN users u ON u.id=a.user_id
    LEFT JOIN normal_inbox_state s ON s.account_id=a.id WHERE a.user_id=? AND a.deleted_at IS NULL AND u.status='active' ORDER BY a.id`)
    .bind(identity.userId).all<SearchAccount>()).results;
  if (accountId && !rows.some(row => row.id === accountId)) throw new HttpError(404, "not_found");
  const expanded = !!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='normal_server_folder_state'").first();
  const contexts: NormalSearchContext[] = [], accounts = rows.filter(row => !accountId || row.id === accountId);
  for (const row of accounts) if (row.epoch_id && row.source_hash === await normalInboxSourceHash(row)) {
    contexts.push({ id: row.id, revision: row.revision, epochId: row.epoch_id, sourceHash: row.source_hash,
      cacheGeneration: row.cache_generation, ...(expanded ? { folderSchema: true as const } : {}) });
  }
  if (expanded && scope === "all" && accounts.length) {
    const folders = (await env.DB.prepare(`SELECT s.*,c.source_hash AS catalog_source,j.value AS folder FROM normal_server_folder_state s
      JOIN normal_server_folder_catalogs c ON c.account_id=s.account_id,json_each(c.folders) j
      WHERE s.account_id IN (SELECT value FROM json_each(?)) AND s.epoch_id IS NOT NULL
      AND json_extract(j.value,'$.id')=s.server_folder_id AND json_extract(j.value,'$.wireName')=s.wire_name
      AND json_extract(j.value,'$.selectable')=1`).bind(JSON.stringify(accounts.map(row => row.id))).all<SearchFolder>()).results;
    const accountMap = new Map(accounts.map(row => [row.id, row]));
    const sources = new Map(await Promise.all(accounts.map(async row => [row.id, await serverFolderSource(row)] as const)));
    for (const row of folders) {
      const folder = JSON.parse(row.folder) as ImapFolder, source = sources.get(row.account_id)!;
      if (folder.wireName.toUpperCase() === "INBOX" || row.catalog_source !== source
        || row.server_folder_id !== await tokenHash(JSON.stringify(["normal-server-folder-v1", row.account_id, source, folder.wireName]))
        || row.source_hash !== await tokenHash(JSON.stringify(["normal-server-folder-inbox-v1", row.account_id, source, folder.wireName]))) continue;
      contexts.push({ id: row.account_id, revision: accountMap.get(row.account_id)!.revision, epochId: row.epoch_id,
        sourceHash: row.source_hash, cacheGeneration: row.cache_generation, folderSchema: true, serverFolderId: row.server_folder_id,
        serverFolderName: folder.name, wireName: folder.wireName, catalogSource: source });
    }
  }
  return contexts.sort((a, b) => {
    const left = `${a.id}:${a.serverFolderId ?? ""}`, right = `${b.id}:${b.serverFolderId ?? ""}`; return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function normalSearchJoin(contexts: NormalSearchContext[]) {
  const inbox = "s.account_id=a.id AND s.epoch_id=m.epoch_id AND s.source_hash=json_extract(c.value,'$.sourceHash') AND s.cache_generation=json_extract(c.value,'$.cacheGeneration')";
  const expanded = contexts.some(context => context.folderSchema);
  return `JOIN normal_accounts a ON a.id=m.account_id JOIN users u ON u.id=a.user_id
    JOIN json_each(?) c ON json_extract(c.value,'$.id')=a.id AND json_extract(c.value,'$.revision')=a.revision AND json_extract(c.value,'$.epochId')=m.epoch_id
    JOIN normal_inbox_batches b ON b.id=m.batch_id AND b.account_id=a.id AND b.epoch_id=m.epoch_id AND b.source_hash=json_extract(c.value,'$.sourceHash')
    ${expanded ? `LEFT JOIN normal_inbox_state s ON ${inbox}
    LEFT JOIN normal_server_folder_state fs ON fs.account_id=a.id AND fs.server_folder_id=m.server_folder_id AND fs.epoch_id=m.epoch_id
      AND fs.wire_name=json_extract(c.value,'$.wireName') AND fs.source_hash=json_extract(c.value,'$.sourceHash') AND fs.cache_generation=json_extract(c.value,'$.cacheGeneration')
    JOIN (SELECT 1) valid ON (json_extract(c.value,'$.serverFolderId') IS NULL AND m.server_folder_id IS NULL AND b.server_folder_id IS NULL AND s.account_id IS NOT NULL)
      OR (json_extract(c.value,'$.serverFolderId')=m.server_folder_id AND b.server_folder_id=m.server_folder_id AND fs.account_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM normal_server_folder_catalogs fc,json_each(fc.folders) f WHERE fc.account_id=a.id AND fc.source_hash=json_extract(c.value,'$.catalogSource')
        AND json_extract(f.value,'$.id')=m.server_folder_id AND json_extract(f.value,'$.wireName')=fs.wire_name AND json_extract(f.value,'$.selectable')=1))`
      : `JOIN normal_inbox_state s ON ${inbox}`}`;
}
export const normalSearchSourceColumns = "json_extract(c.value,'$.serverFolderId') AS source_folder_id,json_extract(c.value,'$.serverFolderName') AS source_folder_name";
export const normalSearchVisible = "a.user_id=? AND a.deleted_at IS NULL AND u.status='active' AND b.status='committed' AND m.purged_at IS NULL";
