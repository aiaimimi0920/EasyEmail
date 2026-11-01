import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { draftInput, draftRevision, UUID } from "./draft-input";
import { draftRow, draftView, removeDraft, saveDraft, type DraftRow } from "./draft-store";
import { draftSourceMatches, draftSourceScope } from "./draft-source";
import { normalAccount } from "./normal-account-store";

export const isDraftPath = (path: string) => /^\/api\/v1\/(?:normal-accounts\/[0-9a-f-]{36}\/)?drafts(?:\/[0-9a-f-]{36})?$/.test(path);

export async function draftRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const url = new URL(request.url), accountId = /^\/api\/v1\/normal-accounts\/([0-9a-f-]{36})\/drafts/.exec(url.pathname)?.[1];
  const base = accountId ? `/api/v1/normal-accounts/${accountId}/drafts` : "/api/v1/drafts";
  const id = url.pathname.slice(base.length + 1), list = url.pathname === base, scope = draftSourceScope(accountId);
  if (accountId) {
    if (!UUID.test(accountId)) throw new HttpError(404, "not_found");
    requireScope(identity, "mail-accounts:read");
    if (!await normalAccount(env, identity.userId, accountId)) throw new HttpError(404, "not_found");
  }
  if (!list && !UUID.test(id)) throw new HttpError(404, "not_found");
  if (request.method === "GET") {
    requireScope(identity, "drafts:read");
    if (!list) {
      if (url.search) throw new HttpError(400, "invalid_filter");
      const row = await draftRow(env, identity, id);
      if (!row || !draftSourceMatches(row, accountId) || row.state === "deleted") throw new HttpError(404, "not_found");
      return json({ draft: draftView(row) });
    }
    const seen = new Set();
    for (const [key] of url.searchParams) {
      if (!["limit", "cursor"].includes(key) || seen.has(key)) throw new HttpError(400, "invalid_filter");
      seen.add(key);
    }
    const { limit, cursor } = pageOptions(url);
    const after = cursor ? await draftRow(env, identity, cursor) : null;
    if (cursor && (!after || !draftSourceMatches(after, accountId) || after.state === "deleted")) throw new HttpError(400, "invalid_cursor");
    const { results } = await env.DB.prepare(`SELECT * FROM drafts WHERE user_id=? AND state!='deleted' AND ${scope.sql}
      ${after ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))" : ""} ORDER BY updated_at DESC,id DESC LIMIT ?`)
      .bind(identity.userId, ...scope.values, ...(after ? [after.updated_at, after.updated_at, cursor] : []), limit + 1).all<DraftRow>();
    const rows = results.slice(0, limit);
    return json({ items: rows.map(row => draftView(row, false)), nextCursor: results.length > limit ? rows.at(-1)!.id : null });
  }
  if (list || !["PUT", "DELETE"].includes(request.method)) throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "drafts:write");
  if (url.search) throw new HttpError(400, "invalid_filter");
  if (request.method === "PUT") {
    const { row, created } = await saveDraft(env, identity, id, await draftInput(request, accountId));
    return json({ draft: draftView(row) }, created ? 201 : 200);
  }
  const body = await readJson(request);
  if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_draft_request");
  return json({ draft: await removeDraft(env, identity, id, draftRevision(body.expectedRevision, false), accountId) });
}
