export interface ContactRow {
  user_id: string; id: string; display_name: string; name_key: string; email_address: string; note: string | null;
  version: number; created_at: number; updated_at: number; deleted_at: number | null;
}
export interface ContactOperation {
  request_key: string; request_hash: string; kind: string; contact_id: string | null; version: number | null;
  deleted: number; completed_at: number | null;
}
export const contactView = (row: ContactRow) => ({ id: row.id, displayName: row.display_name, emailAddress: row.email_address,
  ...(row.note === null ? {} : { note: row.note }), version: row.version,
  createdAt: new Date(row.created_at * 1000).toISOString(), updatedAt: new Date(row.updated_at * 1000).toISOString() });
export const contactOperationView = (row: ContactOperation) => ({ key: row.request_key, kind: row.kind, contactId: row.contact_id,
  version: row.version, deleted: row.deleted === 1, completedAt: row.completed_at });
