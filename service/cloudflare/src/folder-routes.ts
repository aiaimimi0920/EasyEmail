import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { folderInput } from "./folder-input";
import { taxonomyRevision, TAXONOMY_UUID } from "./taxonomy-input";
import { deleteFolder, folderView, saveFolder, type FolderRow } from "./folder-store";

export const isFolderPath = (path: string) => /^\/api\/v1\/folders(?:\/[0-9a-f-]{36})?$/.test(path)
  || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/folder$/.test(path);

export async function folderRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const url = new URL(request.url), message = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/folder$/.exec(url.pathname);
  if (message) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    requireScope(identity, "messages:read"); requireScope(identity, "folders:read");
    if (url.search) throw new HttpError(400, "invalid_filter");
    const owned = await env.DB.prepare("SELECT id FROM messages WHERE user_id=? AND mailbox_id=? AND id=? AND purged_at IS NULL")
      .bind(identity.userId, message[1], message[2]).first();
    if (!owned) throw new HttpError(404, "not_found");
    const row = await env.DB.prepare(`SELECT f.* FROM folders f JOIN message_folders mf ON mf.user_id=f.user_id AND mf.folder_id=f.id
      WHERE mf.user_id=? AND mf.message_id=? AND f.deleted_at IS NULL`).bind(identity.userId, message[2]).first<FolderRow>();
    return json({ folder: row ? folderView(row) : null });
  }
  const list = url.pathname === "/api/v1/folders", id = url.pathname.slice("/api/v1/folders/".length);
  if (!list && !TAXONOMY_UUID.test(id)) throw new HttpError(404, "not_found");
  if (list && request.method === "GET") {
    requireScope(identity, "folders:read");
    for (const key of url.searchParams.keys()) if (!["limit", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "invalid_filter");
    const { limit, cursor } = pageOptions(url);
    if (cursor && !TAXONOMY_UUID.test(cursor)) throw new HttpError(400, "invalid_cursor");
    const { results } = await env.DB.prepare("SELECT * FROM folders WHERE user_id=? AND deleted_at IS NULL AND id>? ORDER BY id LIMIT ?")
      .bind(identity.userId, cursor, limit + 1).all<FolderRow>();
    const rows = results.slice(0, limit);
    return json({ items: rows.map(folderView), nextCursor: results.length > limit ? rows.at(-1)!.id : null });
  }
  if (list || !["PUT", "DELETE"].includes(request.method)) throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "folders:write");
  if (url.search) throw new HttpError(400, "invalid_filter");
  if (request.method === "PUT") {
    const result = await saveFolder(env, identity, id, await folderInput(request));
    return json({ folder: folderView(result.row) }, result.created ? 201 : 200);
  }
  const body = await readJson(request);
  if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_folder_request");
  return json({ folder: await deleteFolder(env, identity, id, taxonomyRevision(body.expectedRevision, "invalid_folder_request", 1)) });
}
