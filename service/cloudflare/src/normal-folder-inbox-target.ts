import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import type { NormalAccount } from "./normal-account-model";
import { serverFolderAccount, serverFolderSource } from "./normal-server-folder-store";
import { tokenHash } from "./security";
import type { ImapFolder } from "./normal-imap-folders";

export interface FolderInboxTarget {
  id: string; wireName: string; catalogSource: string; sourceHash: string; account: NormalAccount;
}
export interface ReceiveFence { sql: string; values: (string | number)[] }
export async function folderInboxTarget(env: Env, identity: Identity, accountId: string, id: string): Promise<FolderInboxTarget> {
  const account = await serverFolderAccount(env, identity, accountId), source = await serverFolderSource(account);
  const row = await env.DB.prepare(`SELECT j.value AS folder FROM normal_server_folder_catalogs c,json_each(c.folders) j
    WHERE c.account_id=? AND c.source_hash=? AND json_extract(j.value,'$.id')=?`).bind(accountId, source, id).first<{ folder: string }>();
  if (!row) throw new HttpError(404, "normal_server_folder_not_current");
  const folder = JSON.parse(row.folder) as ImapFolder;
  if (await tokenHash(JSON.stringify(["normal-server-folder-v1", accountId, source, folder.wireName])) !== id) throw new HttpError(404, "normal_server_folder_not_current");
  if (!folder.selectable) throw new HttpError(409, "normal_server_folder_not_selectable");
  return { id, wireName: folder.wireName, account, catalogSource: source,
    sourceHash: await tokenHash(JSON.stringify(["normal-server-folder-inbox-v1", accountId, source, folder.wireName])) };
}
export function folderInboxMembership(target: FolderInboxTarget): ReceiveFence {
  return { sql: `EXISTS (SELECT 1 FROM normal_server_folder_catalogs c,json_each(c.folders) j WHERE c.account_id=?
    AND c.source_hash=? AND json_extract(j.value,'$.id')=? AND json_extract(j.value,'$.wireName')=? AND json_extract(j.value,'$.selectable')=1)`,
    values: [target.account.id, target.catalogSource, target.id, target.wireName] };
}
