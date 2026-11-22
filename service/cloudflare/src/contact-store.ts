import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import { contactNameKey, defaultContactName, type ContactCommand } from "./contact-input";
import { contactOperationView, type ContactOperation, type ContactRow } from "./contact-model";

export const contactRow = (env: Env, userId: string, id: string) => env.DB.prepare("SELECT * FROM contacts WHERE user_id=? AND id=?")
  .bind(userId, id).first<ContactRow>();
export const contactOperation = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM contact_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<ContactOperation>();
export function completedContactOperation(row: ContactOperation) {
  if (row.completed_at === null || !row.contact_id || row.version === null) throw new HttpError(503, "contact_storage_failed");
  return contactOperationView(row);
}

export async function mutateContact(env: Env, identity: Identity, key: string, command: ContactCommand) {
  const hash = await tokenHash(JSON.stringify(command)), previous = await contactOperation(env, identity.userId, key);
  const replay = (row: ContactOperation) => {
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
    return { operation: completedContactOperation(row), replayed: true };
  };
  if (previous) return replay(previous);
  const current = command.targetId ? await contactRow(env, identity.userId, command.targetId) : null;
  if (command.targetId && (!current || current.deleted_at !== null || current.version !== command.expectedVersion)) {
    // The same key may have committed between the empty receipt snapshot and this target read.
    const raced = await contactOperation(env, identity.userId, key);
    if (raced) return replay(raced);
    throw new HttpError(!current || current.deleted_at !== null ? 404 : 409, !current || current.deleted_at !== null ? "not_found" : "contact_changed");
  }
  const id = crypto.randomUUID(), contactId = command.targetId ?? crypto.randomUUID(), now = unixNow();
  const fence = "EXISTS (SELECT 1 FROM contact_operations WHERE id=? AND completed_at IS NULL)";
  const target = command.kind === "POST"
    ? "AND NOT EXISTS (SELECT 1 FROM contacts WHERE user_id=? AND email_address=? AND deleted_at IS NULL AND version>=9007199254740991)"
    : "AND EXISTS (SELECT 1 FROM contacts WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL)";
  const statements = [env.DB.prepare(`INSERT INTO contact_operations(user_id,request_key,id,request_hash,kind,created_at)
    SELECT ?,?,?,?,?,? WHERE 1 ${target} ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(identity.userId, key, id, hash, command.kind, now, ...(command.kind === "POST" ? [identity.userId, command.fields.emailAddress!] : [identity.userId, contactId, command.expectedVersion!]))];
  const email = command.fields.emailAddress ?? current?.email_address ?? "";
  const name = command.fields.displayName === undefined ? current!.display_name : command.fields.displayName || defaultContactName(email);
  const note = command.fields.note === undefined ? current?.note ?? null : command.fields.note;
  if (command.kind === "POST") {
    statements.push(env.DB.prepare(`INSERT INTO contacts(user_id,id,display_name,name_key,email_address,note,version,created_at,updated_at)
      SELECT ?,?,?,?,?,?,1,?,? WHERE ${fence}
      ON CONFLICT(user_id,email_address) WHERE deleted_at IS NULL DO UPDATE SET display_name=excluded.display_name,name_key=excluded.name_key,
        note=excluded.note,version=contacts.version+1,updated_at=excluded.updated_at WHERE ${fence}`)
      .bind(identity.userId, contactId, name, contactNameKey(name), email, note, now, now, id, id));
  } else if (command.kind === "PATCH") {
    statements.push(env.DB.prepare(`UPDATE contacts SET display_name=?,name_key=?,email_address=?,note=?,version=version+1,updated_at=?
      WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL AND ${fence}`)
      .bind(name, contactNameKey(name), email, note, now, identity.userId, contactId, command.expectedVersion!, id));
  } else {
    statements.push(env.DB.prepare(`UPDATE contacts SET display_name='',name_key='',email_address='',note=NULL,version=version+1,updated_at=?,deleted_at=?
      WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL AND ${fence}`)
      .bind(now, now, identity.userId, contactId, command.expectedVersion!, id));
  }
  const lookup = command.kind === "POST" ? "email_address=? AND deleted_at IS NULL" : "id=?";
  statements.push(env.DB.prepare(`UPDATE contact_operations SET (contact_id,version,deleted)=
    (SELECT id,version,deleted_at IS NOT NULL FROM contacts WHERE user_id=? AND ${lookup}),completed_at=? WHERE id=? AND completed_at IS NULL`)
    .bind(identity.userId, command.kind === "POST" ? email : contactId, now, id));
  let writes: D1Result[];
  try { writes = await env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("UNIQUE constraint failed: contacts.user_id, contacts.email_address")) throw new HttpError(409, "contact_email_unavailable");
    throw new HttpError(503, "contact_storage_failed");
  }
  const row = await contactOperation(env, identity.userId, key);
  if (!row) throw new HttpError(409, "contact_changed");
  return writes[0].meta.changes ? { operation: completedContactOperation(row), replayed: false } : replay(row);
}
