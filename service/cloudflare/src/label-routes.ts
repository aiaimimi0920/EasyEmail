import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { labelInput, labelRevision, LABEL_UUID } from "./label-input";
import { deleteLabel, labelView, saveLabel, type LabelRow } from "./label-store";

export async function labelRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const url = new URL(request.url), list = url.pathname === "/api/v1/labels", id = url.pathname.slice("/api/v1/labels/".length);
  if (!list && !LABEL_UUID.test(id)) throw new HttpError(404, "not_found");
  if (list && request.method === "GET") {
    requireScope(identity, "labels:read");
    for (const key of url.searchParams.keys()) if (!["limit", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "invalid_filter");
    const { limit, cursor } = pageOptions(url);
    if (cursor && !LABEL_UUID.test(cursor)) throw new HttpError(400, "invalid_cursor");
    const { results } = await env.DB.prepare(`SELECT * FROM labels WHERE user_id=? AND deleted_at IS NULL AND id>? ORDER BY id LIMIT ?`)
      .bind(identity.userId, cursor, limit + 1).all<LabelRow>();
    const rows = results.slice(0, limit);
    return json({ items: rows.map(labelView), nextCursor: results.length > limit ? rows.at(-1)!.id : null });
  }
  if (list || !["PUT", "DELETE"].includes(request.method)) throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "labels:write");
  if (url.search) throw new HttpError(400, "invalid_filter");
  if (request.method === "PUT") {
    const result = await saveLabel(env, identity, id, await labelInput(request));
    return json({ label: labelView(result.row) }, result.created ? 201 : 200);
  }
  const body = await readJson(request);
  if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_label_request");
  return json({ label: await deleteLabel(env, identity, id, labelRevision(body.expectedRevision, 1)) });
}

export async function getMessageLabels(request: Request, env: Env, identity: Identity, mailboxId: string, id: string) {
  requireScope(identity, "messages:read"); requireScope(identity, "labels:read");
  if (new URL(request.url).search) throw new HttpError(400, "invalid_filter");
  const message = await env.DB.prepare("SELECT id FROM messages WHERE user_id=? AND mailbox_id=? AND id=? AND purged_at IS NULL")
    .bind(identity.userId, mailboxId, id).first();
  if (!message) throw new HttpError(404, "not_found");
  const { results } = await env.DB.prepare(`SELECT l.* FROM labels l JOIN message_labels ml ON ml.user_id=l.user_id AND ml.label_id=l.id
    WHERE ml.user_id=? AND ml.message_id=? AND l.deleted_at IS NULL ORDER BY l.id`).bind(identity.userId, id).all<LabelRow>();
  return json({ items: results.map(labelView) });
}
