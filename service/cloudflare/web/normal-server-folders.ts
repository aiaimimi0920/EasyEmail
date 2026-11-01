import { api, ApiError } from "./api";
import type { NormalAccount } from "./normal-accounts";

export interface ServerFolder { id: string; wireName: string; name: string; delimiter: string | null; attributes: string[]; roles: string[]; selectable: boolean }
export interface ServerFolderCatalog {
  accountId: string; accountRevision: number; current: boolean; complete: boolean; snapshotId: string | null;
  snapshotAccountRevision: number | null; observedAt: number | null; items: ServerFolder[];
}
export async function serverFolders(account: NormalAccount, discover: boolean, signal?: AbortSignal) {
  const result = await api<{ catalog: ServerFolderCatalog }>(`/normal-accounts/${account.id}/server-folders${discover ? "/discover" : ""}`,
    discover ? "POST" : "GET", discover ? { expectedRevision: account.revision } : undefined, undefined, signal);
  const row = result.catalog;
  if (!row || row.accountId !== account.id || row.accountRevision !== account.revision || typeof row.current !== "boolean" || row.complete !== row.current
    || !Array.isArray(row.items) || row.items.length > 128
    || (row.current ? typeof row.snapshotId !== "string" || !/^[0-9a-f-]{36}$/.test(row.snapshotId)
      || !Number.isSafeInteger(row.observedAt) || !Number.isSafeInteger(row.snapshotAccountRevision) || row.snapshotAccountRevision! < 1
      : row.snapshotId !== null || row.observedAt !== null || row.snapshotAccountRevision !== null || row.items.length !== 0)
    || row.items.some(folder => !folder || !/^[0-9a-f]{64}$/.test(folder.id) || typeof folder.name !== "string" || !folder.name || folder.name.length > 512
      || typeof folder.wireName !== "string" || !folder.wireName || folder.wireName.length > 1024 || typeof folder.selectable !== "boolean"
      || (folder.delimiter !== null && (typeof folder.delimiter !== "string" || folder.delimiter.length !== 1))
      || !Array.isArray(folder.attributes) || folder.attributes.length > 32 || folder.attributes.some(value => typeof value !== "string" || value.length > 81)
      || !Array.isArray(folder.roles) || folder.roles.some(value => !["inbox", "all", "archive", "drafts", "flagged", "junk", "sent", "trash"].includes(value)))
    || new Set(row.items.map(folder => folder.id)).size !== row.items.length) throw new ApiError(502, "normal_folder_response_invalid");
  return row;
}
