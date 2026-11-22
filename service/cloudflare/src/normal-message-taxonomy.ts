import type { Env, Identity } from "./contracts";
import { HttpError, json } from "./http";
import { requireScope } from "./identity";
import { labelView, type LabelRow } from "./label-store";
import { folderView, type FolderRow } from "./folder-store";
import { normalInboxContext, normalStoredMessage, assertNormalInboxCurrent } from "./normal-inbox-access";
import { requireTaxonomyFilters, type TaxonomyFilters } from "./taxonomy-access";
import { folderInboxContext, folderStoredMessage, assertFolderInboxCurrent } from "./normal-folder-inbox-access";

export async function normalTaxonomySelection(env: Env, identity: Identity, filters: TaxonomyFilters & { folder: string }) {
  await requireTaxonomyFilters(env, identity, filters);
  const conditions: string[] = [], values: string[] = [];
  const placement = `SELECT 1 FROM normal_message_folders mf JOIN folders f ON f.user_id=mf.user_id AND f.id=mf.folder_id
    WHERE mf.user_id=? AND mf.message_id=m.id AND f.deleted_at IS NULL`;
  if (filters.folderId) { conditions.push(`EXISTS (${placement} AND mf.folder_id=?)`); values.push(identity.userId, filters.folderId); }
  else if (filters.folder === "inbox") { conditions.push(`NOT EXISTS (${placement})`); values.push(identity.userId); }
  if (filters.labelId) {
    conditions.push(`EXISTS (SELECT 1 FROM normal_message_labels ml JOIN labels l ON l.user_id=ml.user_id AND l.id=ml.label_id
      WHERE ml.user_id=? AND ml.message_id=m.id AND ml.label_id=? AND l.deleted_at IS NULL)`);
    values.push(identity.userId, filters.labelId);
  }
  return { condition: conditions.join(" AND ") || "1", values };
}

export async function getNormalTaxonomy(request: Request, env: Env, identity: Identity, accountId: string, id: string, kind: "labels" | "folder", folderId = "") {
  requireScope(identity, kind === "labels" ? "labels:read" : "folders:read");
  if (new URL(request.url).search) throw new HttpError(400, "invalid_filter");
  const context = folderId ? await folderInboxContext(env, identity, accountId, folderId) : await normalInboxContext(env, identity, accountId);
  if (folderId) await folderStoredMessage(env, context, id); else await normalStoredMessage(env, context, id);
  let result;
  if (kind === "labels") {
    const rows = (await env.DB.prepare(`SELECT l.* FROM labels l JOIN normal_message_labels ml ON ml.user_id=l.user_id AND ml.label_id=l.id
      WHERE ml.user_id=? AND ml.message_id=? AND l.deleted_at IS NULL ORDER BY l.id`).bind(identity.userId, id).all<LabelRow>()).results;
    result = { items: rows.map(labelView) };
  } else {
    const row = await env.DB.prepare(`SELECT f.* FROM folders f JOIN normal_message_folders mf ON mf.user_id=f.user_id AND mf.folder_id=f.id
      WHERE mf.user_id=? AND mf.message_id=? AND f.deleted_at IS NULL`).bind(identity.userId, id).first<FolderRow>();
    result = { folder: row ? folderView(row) : null };
  }
  if (folderId) await assertFolderInboxCurrent(env, identity, context); else await assertNormalInboxCurrent(env, identity, context);
  return json(result);
}
