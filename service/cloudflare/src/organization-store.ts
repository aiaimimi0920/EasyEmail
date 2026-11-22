import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import { organizationScopes, type OrganizationInput } from "./organization-input";
import { tokenHash } from "./security";

interface OperationRow {
  id: string; request_key: string; request_hash: string; required_scopes: string; message_count: number; created_at: number; completed_at: number | null;
}
export const organizationRow = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM organization_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<OperationRow>();
export function organizationView(row: OperationRow, identity: Identity) {
  for (const scope of JSON.parse(row.required_scopes) as string[]) requireScope(identity, scope);
  if (row.completed_at === null) throw new HttpError(503, "organization_storage_failed");
  return { id: row.id, key: row.request_key, messageCount: row.message_count, completedAt: row.completed_at };
}

export async function runOrganization(env: Env, identity: Identity, key: string, input: OrganizationInput) {
  const hash = await tokenHash(JSON.stringify(input)), previous = await organizationRow(env, identity.userId, key);
  const replay = (row: OperationRow) => {
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
    return { operation: organizationView(row, identity), replayed: true };
  };
  if (previous) return replay(previous);
  const id = crypto.randomUUID(), now = unixNow(), messages = JSON.stringify(input.messageIds);
  const labels = JSON.stringify([...input.addLabelIds, ...input.removeLabelIds]);
  const folderFence = input.folderId ? "AND EXISTS (SELECT 1 FROM folders WHERE user_id=? AND id=? AND deleted_at IS NULL)" : "";
  const guard = "EXISTS (SELECT 1 FROM organization_operations WHERE id=? AND completed_at IS NULL)";
  const statements = [env.DB.prepare(`INSERT INTO organization_operations(user_id,request_key,id,request_hash,required_scopes,message_count,created_at)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id
      WHERE m.user_id=? AND b.user_id=? AND m.purged_at IS NULL AND m.id IN (SELECT value FROM json_each(?)))=?
    AND (SELECT COUNT(*) FROM labels WHERE user_id=? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)))=?
    ${folderFence} ON CONFLICT(user_id,request_key) DO NOTHING`).bind(identity.userId, key, id, hash, JSON.stringify(organizationScopes(input)), input.messageIds.length, now,
      identity.userId, identity.userId, messages, input.messageIds.length, identity.userId, labels, input.addLabelIds.length + input.removeLabelIds.length,
      ...(input.folderId ? [identity.userId, input.folderId] : []))];
  const assignments: string[] = [], values: (number | null)[] = [];
  for (const [field, value] of [["is_read", input.isRead], ["starred", input.starred], ["archived", input.archived]] as const) {
    if (value !== null) { assignments.push(`${field}=?`); values.push(value ? 1 : 0); }
  }
  if (input.trashed !== null) {
    assignments.push(input.trashed ? "trashed_at=COALESCE(trashed_at,?)" : "trashed_at=?"); values.push(input.trashed ? now : null);
  }
  if (input.folderId !== undefined) assignments.push("archived=0");
  if (assignments.length) statements.push(env.DB.prepare(`UPDATE messages SET ${assignments.join(",")}
    WHERE user_id=? AND id IN (SELECT value FROM json_each(?)) AND ${guard}`).bind(...values, identity.userId, messages, id));
  if (input.removeLabelIds.length) statements.push(env.DB.prepare(`DELETE FROM message_labels WHERE user_id=?
    AND message_id IN (SELECT value FROM json_each(?)) AND label_id IN (SELECT value FROM json_each(?)) AND ${guard}`)
    .bind(identity.userId, messages, JSON.stringify(input.removeLabelIds), id));
  if (input.addLabelIds.length) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO message_labels(user_id,message_id,label_id)
    SELECT ?,m.value,l.value FROM json_each(?) m CROSS JOIN json_each(?) l WHERE ${guard}`)
    .bind(identity.userId, messages, JSON.stringify(input.addLabelIds), id));
  if (input.folderId !== undefined || input.archived !== null) statements.push(env.DB.prepare(`DELETE FROM message_folders
    WHERE user_id=? AND message_id IN (SELECT value FROM json_each(?)) AND ${guard}`).bind(identity.userId, messages, id));
  if (input.folderId) statements.push(env.DB.prepare(`INSERT INTO message_folders(user_id,message_id,folder_id)
    SELECT ?,value,? FROM json_each(?) WHERE ${guard}`).bind(identity.userId, input.folderId, messages, id));
  statements.push(env.DB.prepare("UPDATE organization_operations SET completed_at=? WHERE id=? AND completed_at IS NULL").bind(now, id));
  let writes: D1Result[];
  try { writes = await env.DB.batch(statements); } catch { throw new HttpError(503, "organization_storage_failed"); }
  const row = await organizationRow(env, identity.userId, key);
  if (!row) throw new HttpError(409, "organization_target_changed");
  return writes[0].meta.changes ? { operation: organizationView(row, identity), replayed: false } : replay(row);
}
