import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import type { FolderInput } from "./folder-input";
import { folderParentFence } from "./folder-hierarchy";

export interface FolderRow {
  user_id: string; id: string; name: string; name_key: string; color: string; parent_id: string | null; revision: number;
  deleted_at: number | null; created_at: number; updated_at: number;
}
export const folderView = (row: FolderRow) => ({ id: row.id, name: row.name, color: row.color, parentId: row.parent_id, revision: row.revision });
export const folderRow = (env: Env, userId: string, id: string) => env.DB.prepare("SELECT * FROM folders WHERE user_id=? AND id=?")
  .bind(userId, id).first<FolderRow>();

export async function requireFolder(env: Env, identity: Identity, id: string) {
  const row = await folderRow(env, identity.userId, id);
  if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
  return row;
}

export async function saveFolder(env: Env, identity: Identity, id: string, input: FolderInput) {
  const previous = await folderRow(env, identity.userId, id), now = unixNow();
  const replay = (row: FolderRow | null) => row && row.deleted_at === null && row.revision === input.expectedRevision + 1
    && row.name === input.name && row.color === input.color && row.parent_id === input.parentId;
  if (replay(previous)) return { row: previous!, created: false };
  if (previous && (previous.deleted_at !== null || previous.revision !== input.expectedRevision)) throw new HttpError(409, "folder_changed");
  if (!previous && input.expectedRevision !== 0) throw new HttpError(404, "not_found");
  const parent = folderParentFence(identity.userId, id, input.parentId);
  const validParent = () => env.DB.prepare(`SELECT 1 AS valid WHERE ${parent.sql}`).bind(...parent.bindings).first();
  if (!await validParent()) throw new HttpError(409, "folder_parent_invalid");
  let result: D1Result;
  try {
    result = previous ? await env.DB.prepare(`UPDATE folders SET name=?,name_key=?,color=?,parent_id=?,revision=revision+1,updated_at=?
      WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL AND ${parent.sql}`)
      .bind(input.name, input.nameKey, input.color, input.parentId, now, identity.userId, id, input.expectedRevision, ...parent.bindings).run()
      : await env.DB.prepare(`INSERT INTO folders(user_id,id,name,name_key,color,parent_id,revision,created_at,updated_at)
        SELECT ?,?,?,?,?,?,1,?,? WHERE (SELECT COUNT(*) FROM folders WHERE user_id=? AND deleted_at IS NULL)<100 AND ${parent.sql}
        ON CONFLICT(user_id,id) DO NOTHING`).bind(identity.userId, id, input.name, input.nameKey, input.color, input.parentId, now, now, identity.userId, ...parent.bindings).run();
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: folders.user_id, folders.name_key")) throw new HttpError(409, "folder_name_unavailable");
    throw new HttpError(503, "folder_storage_failed");
  }
  const row = await folderRow(env, identity.userId, id);
  if (!result.meta.changes && !replay(row)) {
    if (!await validParent()) throw new HttpError(409, "folder_parent_invalid");
    throw new HttpError(409, row ? "folder_changed" : "folder_limit");
  }
  if (!replay(row)) throw new HttpError(409, "folder_changed");
  return { row: row!, created: !previous && !!result.meta.changes };
}

export async function deleteFolder(env: Env, identity: Identity, id: string, revision: number) {
  const now = unixNow(), guard = "EXISTS (SELECT 1 FROM folders WHERE user_id=? AND id=? AND deleted_at IS NOT NULL AND revision=?)";
  const fence = [identity.userId, id, revision + 1]; let writes: D1Result[];
  try {
    writes = await env.DB.batch([
      env.DB.prepare(`UPDATE folders SET name='',name_key='',parent_id=NULL,revision=revision+1,deleted_at=?,updated_at=?
        WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL`).bind(now, now, identity.userId, id, revision),
      env.DB.prepare(`UPDATE folders SET parent_id=NULL,revision=revision+1,updated_at=? WHERE user_id=? AND parent_id=? AND deleted_at IS NULL AND ${guard}`)
        .bind(now, identity.userId, id, ...fence),
      env.DB.prepare(`UPDATE messages SET archived=0 WHERE user_id=? AND id IN
        (SELECT message_id FROM message_folders WHERE user_id=? AND folder_id=?) AND ${guard}`).bind(identity.userId, identity.userId, id, ...fence),
      env.DB.prepare(`DELETE FROM message_folders WHERE user_id=? AND folder_id=? AND ${guard}`).bind(identity.userId, id, ...fence),
      env.DB.prepare(`UPDATE normal_message_state SET archived=0 WHERE message_id IN
        (SELECT message_id FROM normal_message_folders WHERE user_id=? AND folder_id=?) AND ${guard}`).bind(identity.userId, id, ...fence),
      env.DB.prepare(`DELETE FROM normal_message_folders WHERE user_id=? AND folder_id=? AND ${guard}`).bind(identity.userId, id, ...fence),
    ]);
  } catch { throw new HttpError(503, "folder_storage_failed"); }
  const row = await folderRow(env, identity.userId, id);
  if (!row) throw new HttpError(404, "not_found");
  if (!writes[0].meta.changes && !(row.deleted_at !== null && row.revision === revision + 1)) throw new HttpError(409, "folder_changed");
  return { id, revision: row.revision, deleted: true };
}
