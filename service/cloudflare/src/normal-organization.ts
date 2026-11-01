import type { Env, Identity } from "./contracts";
import { HttpError, json } from "./http";
import { identityCredentialFence, requireScope, requireWriteScope } from "./identity";
import { organizationInput, organizationScopes, type OrganizationInput } from "./organization-input";
import { normalInboxContext } from "./normal-inbox-access";
import { folderInboxContext, separateFolderInbox } from "./normal-folder-inbox-access";
import { folderInboxMembership } from "./normal-folder-inbox-target";
import { normalSearchContexts, normalSearchJoin, normalSearchVisible } from "./normal-search-index";
import { tokenHash } from "./security";

interface Operation {
  id: string; request_key: string; request_hash: string; required_scopes: string; account_id: string; account_revision: number;
  epoch_id: string; message_count: number; completed_at: number | null;
  server_folder_id?: string | null;
}
const operationRow = (env: Env, identity: Identity, accountId: string, key: string) => env.DB.prepare(`SELECT o.*
  FROM normal_organization_operations o JOIN normal_accounts a ON a.id=o.account_id JOIN users u ON u.id=a.user_id
  WHERE o.account_id=? AND o.request_key=? AND a.user_id=? AND a.deleted_at IS NULL AND u.status='active'`)
  .bind(accountId, key, identity.userId).first<Operation>();
function view(row: Operation, identity: Identity) {
  for (const scope of JSON.parse(row.required_scopes) as string[]) requireScope(identity, scope);
  if (row.completed_at === null) throw new HttpError(503, "normal_organization_storage_failed");
  return { id: row.id, key: row.request_key, accountId: row.account_id, accountRevision: row.account_revision,
    epochId: row.epoch_id, messageCount: row.message_count, completedAt: row.completed_at, upstreamChanged: false,
    ...(row.server_folder_id ? { serverFolderId: row.server_folder_id } : {}) };
}
async function run(env: Env, identity: Identity, accountId: string, key: string, input: OrganizationInput, folderId = "") {
  await normalInboxContext(env, identity, accountId);
  const previous = await operationRow(env, identity, accountId, key);
  const requestHash = (folder: string) => tokenHash(JSON.stringify(folder
    ? ["normal-folder-organization-v1", accountId, folder, input] : ["normal-organization-v1", accountId, input]));
  let hash = await requestHash(folderId);
  const replay = (row: Operation) => {
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
    return { operation: view(row, identity), replayed: true };
  };
  if (previous && (!folderId || previous.server_folder_id)) return replay(previous);
  const target = folderId ? await folderInboxContext(env, identity, accountId, folderId) : null;
  const serverFolderId = target && separateFolderInbox(target) ? folderId : "";
  hash = await requestHash(serverFolderId); if (previous) return replay(previous);
  const context = (await normalSearchContexts(env, identity, accountId, serverFolderId ? "all" : "inbox"))
    .find(context => (context.serverFolderId ?? "") === serverFolderId);
  if (!context) throw new HttpError(409, "normal_organization_changed_or_limit");
  if (serverFolderId && !await env.DB.prepare("SELECT 1 FROM pragma_table_info('normal_organization_operations') WHERE name='server_folder_id'").first()) {
    throw new HttpError(503, "normal_folder_organization_migration_required");
  }
  const id = crypto.randomUUID(), messages = JSON.stringify(input.messageIds);
  const labels = JSON.stringify([...input.addLabelIds, ...input.removeLabelIds]);
  const folderFence = input.folderId ? "AND EXISTS (SELECT 1 FROM folders WHERE user_id=? AND id=? AND deleted_at IS NULL)" : "";
  const contexts = [context], membership = target ? folderInboxMembership(target.serverFolder!) : { sql: "1", values: [] };
  const fence = `${identityCredentialFence(identity)} AND ${membership.sql}`;
  const guard = "EXISTS (SELECT 1 FROM normal_organization_operations WHERE id=? AND completed_at IS NULL)";
  const statements = [env.DB.prepare(`INSERT INTO normal_organization_operations
    (account_id,request_key,id,request_hash,account_revision,epoch_id,required_scopes,message_count,created_at${serverFolderId ? ",server_folder_id" : ""})
    SELECT ?,?,?,?,?,?,?,?,unixepoch()${serverFolderId ? ",?" : ""} WHERE ${fence}
    AND (SELECT COUNT(*) FROM normal_organization_operations WHERE account_id=?)<10000
    AND (SELECT COUNT(*) FROM normal_inbox_messages m ${normalSearchJoin(contexts)}
      WHERE ${normalSearchVisible} AND m.id IN (SELECT value FROM json_each(?)))=?
    AND (SELECT COUNT(*) FROM labels WHERE user_id=? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)))=? ${folderFence}
    ON CONFLICT(account_id,request_key) DO NOTHING`).bind(accountId, key, id, hash, context.revision, context.epochId,
      JSON.stringify(organizationScopes(input)), input.messageIds.length, ...(serverFolderId ? [serverFolderId] : []),
      identity.credentialId, identity.userId, ...membership.values, accountId, JSON.stringify(contexts), identity.userId, messages, input.messageIds.length, identity.userId, labels,
      input.addLabelIds.length + input.removeLabelIds.length, ...(input.folderId ? [identity.userId, input.folderId] : []))];
  const values = [input.isRead, input.starred, input.folderId !== undefined ? false : input.archived].map(value => value === null ? null : Number(value));
  statements.push(env.DB.prepare(`INSERT INTO normal_message_state(message_id,is_read,starred,archived,trashed_at)
    SELECT m.id,COALESCE(?,ns.is_read,0),COALESCE(?,ns.starred,0),COALESCE(?,ns.archived,0),
      CASE WHEN ? IS NULL THEN ns.trashed_at WHEN ?=1 THEN COALESCE(ns.trashed_at,unixepoch()) ELSE NULL END
    FROM normal_inbox_messages m LEFT JOIN normal_message_state ns ON ns.message_id=m.id
    WHERE m.account_id=? AND m.epoch_id=? AND m.id IN (SELECT value FROM json_each(?)) AND ${guard}
    ON CONFLICT(message_id) DO UPDATE SET is_read=excluded.is_read,starred=excluded.starred,archived=excluded.archived,trashed_at=excluded.trashed_at`)
    .bind(...values, input.trashed === null ? null : Number(input.trashed), Number(input.trashed), accountId, context.epochId, messages, id));
  if (input.removeLabelIds.length) statements.push(env.DB.prepare(`DELETE FROM normal_message_labels WHERE user_id=?
    AND message_id IN (SELECT value FROM json_each(?)) AND label_id IN (SELECT value FROM json_each(?)) AND ${guard}`)
    .bind(identity.userId, messages, JSON.stringify(input.removeLabelIds), id));
  if (input.addLabelIds.length) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO normal_message_labels(user_id,message_id,label_id)
    SELECT ?,m.value,l.value FROM json_each(?) m CROSS JOIN json_each(?) l WHERE ${guard}`)
    .bind(identity.userId, messages, JSON.stringify(input.addLabelIds), id));
  if (input.folderId !== undefined || input.archived !== null) statements.push(env.DB.prepare(`DELETE FROM normal_message_folders
    WHERE user_id=? AND message_id IN (SELECT value FROM json_each(?)) AND ${guard}`).bind(identity.userId, messages, id));
  if (input.folderId) statements.push(env.DB.prepare(`INSERT INTO normal_message_folders(user_id,message_id,folder_id)
    SELECT ?,value,? FROM json_each(?) WHERE ${guard}`).bind(identity.userId, input.folderId, messages, id));
  statements.push(env.DB.prepare("UPDATE normal_organization_operations SET completed_at=unixepoch() WHERE id=? AND completed_at IS NULL").bind(id));
  let changed;
  try { changed = !!(await env.DB.batch(statements))[0].meta.changes; }
  catch {
    const known = await operationRow(env, identity, accountId, key);
    if (known && known.completed_at !== null) return replay(known);
    throw new HttpError(503, "normal_organization_storage_failed");
  }
  const row = await operationRow(env, identity, accountId, key);
  if (!row) throw new HttpError(409, "normal_organization_changed_or_limit");
  return changed ? { operation: view(row, identity), replayed: false } : replay(row);
}
export async function organizeNormalMessages(request: Request, env: Env, identity: Identity, accountId: string, folderId = "") {
  requireWriteScope(request, env, identity, "messages:write");
  const input = await organizationInput(request), key = request.headers.get("idempotency-key") ?? "";
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  for (const scope of organizationScopes(input)) requireScope(identity, scope);
  return json(await run(env, identity, accountId, key, input, folderId));
}
export async function getNormalOrganization(env: Env, identity: Identity, accountId: string, key: string, folderId = "") {
  await normalInboxContext(env, identity, accountId);
  const row = await operationRow(env, identity, accountId, key);
  if (!row) throw new HttpError(404, "not_found");
  if (folderId && row.server_folder_id !== folderId) {
    if (row.server_folder_id || separateFolderInbox(await folderInboxContext(env, identity, accountId, folderId))) throw new HttpError(404, "not_found");
  }
  return json({ operation: view(row, identity) });
}
