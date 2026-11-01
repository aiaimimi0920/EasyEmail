import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireWriteScope } from "./identity";
import { getMailbox } from "./mailbox-queries";

type Field = { column: string; max?: number };
const MAILBOX_FIELDS: Record<string, Field> = {
  displayName: { column: "display_name", max: 80 }, note: { column: "note", max: 1000 },
  favorite: { column: "favorite" }, paused: { column: "paused" },
};
const MESSAGE_FIELDS: Record<string, Field> = {
  isRead: { column: "is_read" }, starred: { column: "starred" }, archived: { column: "archived" },
};

function patchFields(body: Record<string, unknown>, allowed: Record<string, Field>) {
  const entries = Object.entries(body);
  if (!entries.length) throw new HttpError(400, "empty_patch");
  return entries.map(([name, value]) => {
    if (!Object.hasOwn(allowed, name)) throw new HttpError(400, "invalid_patch_field");
    const field = allowed[name];
    if (field.max !== undefined) {
      if (typeof value !== "string" || value.length > field.max) throw new HttpError(400, `invalid_${name}`);
      return { column: field.column, value: name === "displayName" ? value.trim() : value };
    }
    if (typeof value !== "boolean") throw new HttpError(400, `invalid_${name}`);
    return { column: field.column, value: value ? 1 : 0 };
  });
}

export async function patchMailbox(request: Request, env: Env, identity: Identity, id: string): Promise<Response> {
  requireWriteScope(request, env, identity, "mailboxes:write");
  const body = await readJson(request);
  const fields = patchFields(body, MAILBOX_FIELDS);
  const assignments = fields.map((field) => `${field.column} = ?`);
  const pauseBindings: number[] = [];
  if (body.paused !== undefined) {
    // Only a transition cancels the old owner; a retried no-op resume must not cancel a new sync.
    assignments.push("sync_revision = sync_revision + (paused <> ?)",
      "sync_token = CASE WHEN paused <> ? THEN NULL ELSE sync_token END",
      "sync_lease_until = CASE WHEN paused <> ? THEN NULL ELSE sync_lease_until END");
    pauseBindings.push(...Array<number>(3).fill(body.paused ? 1 : 0));
  }
  const result = await env.DB.prepare(`UPDATE mailboxes SET ${assignments.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...fields.map((field) => field.value), ...pauseBindings, id, identity.userId).run();
  if (!result.meta.changes) throw new HttpError(404, "not_found");
  return getMailbox(env, { ...identity, scopes: [...identity.scopes, "mailboxes:read"] }, id);
}

export async function patchMessage(request: Request, env: Env, identity: Identity, mailboxId: string, id: string): Promise<Response> {
  requireWriteScope(request, env, identity, "messages:write");
  const fields = patchFields(await readJson(request), MESSAGE_FIELDS);
  const statement = env.DB.prepare(`UPDATE messages SET ${fields.map((field) => `${field.column} = ?`).join(", ")}
    WHERE id = ? AND mailbox_id = ? AND user_id = ? AND purged_at IS NULL RETURNING id, is_read, starred, archived`)
    .bind(...fields.map((field) => field.value), id, mailboxId, identity.userId);
  const writes = await env.DB.batch([statement, ...(fields.some(field => field.column === "archived") ? [env.DB.prepare(`DELETE FROM message_folders
    WHERE user_id=? AND message_id=? AND EXISTS (SELECT 1 FROM messages WHERE id=? AND mailbox_id=? AND user_id=? AND purged_at IS NULL)`)
    .bind(identity.userId, id, id, mailboxId, identity.userId)] : [])]);
  const row = writes[0].results[0] as { id: string; is_read: number; starred: number; archived: number } | undefined;
  if (!row) throw new HttpError(404, "not_found");
  return json({ state: { id: row.id, isRead: row.is_read === 1, starred: row.starred === 1, archived: row.archived === 1 } });
}
