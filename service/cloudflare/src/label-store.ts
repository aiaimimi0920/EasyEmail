import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import type { LabelInput } from "./label-input";

export interface LabelRow {
  user_id: string; id: string; name: string; name_key: string; color: string; revision: number;
  deleted_at: number | null; created_at: number; updated_at: number;
}
export const labelView = (row: LabelRow) => ({ id: row.id, name: row.name, color: row.color, revision: row.revision });
export const labelRow = (env: Env, userId: string, id: string) => env.DB.prepare("SELECT * FROM labels WHERE user_id=? AND id=?")
  .bind(userId, id).first<LabelRow>();

export async function requireLabel(env: Env, identity: Identity, id: string) {
  const row = await labelRow(env, identity.userId, id);
  if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
  return row;
}

export async function saveLabel(env: Env, identity: Identity, id: string, input: LabelInput) {
  const previous = await labelRow(env, identity.userId, id), now = unixNow();
  const replay = (row: LabelRow | null) => row && row.deleted_at === null && row.revision === input.expectedRevision + 1
    && row.name === input.name && row.color === input.color;
  if (replay(previous)) return { row: previous!, created: false };
  if (previous && (previous.deleted_at !== null || previous.revision !== input.expectedRevision)) throw new HttpError(409, "label_changed");
  if (!previous && input.expectedRevision !== 0) throw new HttpError(404, "not_found");
  let result: D1Result;
  try {
    result = previous ? await env.DB.prepare(`UPDATE labels SET name=?,name_key=?,color=?,revision=revision+1,updated_at=?
      WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL`)
      .bind(input.name, input.nameKey, input.color, now, identity.userId, id, input.expectedRevision).run()
      : await env.DB.prepare(`INSERT INTO labels(user_id,id,name,name_key,color,revision,created_at,updated_at)
        SELECT ?,?,?,?,?,1,?,? WHERE (SELECT COUNT(*) FROM labels WHERE user_id=? AND deleted_at IS NULL)<100
        ON CONFLICT(user_id,id) DO NOTHING`).bind(identity.userId, id, input.name, input.nameKey, input.color, now, now, identity.userId).run();
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: labels.user_id, labels.name_key")) throw new HttpError(409, "label_name_unavailable");
    throw new HttpError(503, "label_storage_failed");
  }
  const row = await labelRow(env, identity.userId, id);
  if (!result.meta.changes && !replay(row)) throw new HttpError(409, row ? "label_changed" : "label_limit");
  if (!replay(row)) throw new HttpError(409, "label_changed");
  return { row: row!, created: !previous && !!result.meta.changes };
}

export async function deleteLabel(env: Env, identity: Identity, id: string, revision: number) {
  const now = unixNow();
  let writes: D1Result[];
  try {
    writes = await env.DB.batch([
      env.DB.prepare(`UPDATE labels SET name='',name_key='',revision=revision+1,deleted_at=?,updated_at=?
        WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL`).bind(now, now, identity.userId, id, revision),
      env.DB.prepare(`DELETE FROM message_labels WHERE user_id=? AND label_id=? AND EXISTS
        (SELECT 1 FROM labels WHERE user_id=? AND id=? AND deleted_at IS NOT NULL AND revision=?)`)
        .bind(identity.userId, id, identity.userId, id, revision + 1),
      env.DB.prepare(`DELETE FROM normal_message_labels WHERE user_id=? AND label_id=? AND EXISTS
        (SELECT 1 FROM labels WHERE user_id=? AND id=? AND deleted_at IS NOT NULL AND revision=?)`)
        .bind(identity.userId, id, identity.userId, id, revision + 1),
    ]);
  } catch { throw new HttpError(503, "label_storage_failed"); }
  const row = await labelRow(env, identity.userId, id);
  if (!row) throw new HttpError(404, "not_found");
  if (!writes[0].meta.changes && !(row.deleted_at !== null && row.revision === revision + 1)) throw new HttpError(409, "label_changed");
  return { id, revision: row.revision, deleted: true };
}
