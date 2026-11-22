import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { normalInboxContext, assertNormalInboxCurrent, normalStoredMessage, type NormalStoredMessage } from "./normal-inbox-access";
import { normalContent, normalSummary } from "./normal-inbox-objects";
import { downloadable } from "./attachment-policy";
import { normalFolderCondition, normalPlatformState, normalStateJoin, normalStateColumns } from "./normal-message-state";
import { normalTaxonomySelection } from "./normal-message-taxonomy";
import { TAXONOMY_UUID } from "./taxonomy-input";
import { folderInboxContext, assertFolderInboxCurrent, folderStoredMessage, separateFolderInbox } from "./normal-folder-inbox-access";
import { normalInboxSourceHash } from "./normal-inbox-claim";

async function summary(env: Env, row: NormalStoredMessage) {
  let header;
  try { header = row.summary ? normalSummary(JSON.parse(row.summary)) : normalSummary(await normalContent(env, row)); }
  catch { throw new HttpError(503, "normal_content_unavailable"); }
  return { id: row.id, accountId: row.account_id, epochId: row.epoch_id, uid: row.uid, ...header,
    receivedAt: row.received_at, observedAt: row.observed_at, remoteFlags: JSON.parse(row.flags) as string[], platformState: normalPlatformState(row) };
}
export async function listNormalMessages(request: Request, env: Env, identity: Identity, accountId: string, serverFolderId?: string) {
  const context = serverFolderId ? await folderInboxContext(env, identity, accountId, serverFolderId) : await normalInboxContext(env, identity, accountId), url = new URL(request.url);
  if (serverFolderId && [...url.searchParams.keys()].some(key => !["limit", "cursor"].includes(key))) throw new HttpError(400, "invalid_filter");
  if ([...url.searchParams.keys()].some(key => !["limit", "cursor", "folder", "folderId"].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new HttpError(400, "invalid_filter");
  const folder = url.searchParams.get("folder") ?? "inbox", folderId = url.searchParams.get("folderId");
  if (folderId !== null && !TAXONOMY_UUID.test(folderId)) throw new HttpError(400, "invalid_filter");
  const suffix = serverFolderId ? `:server:${serverFolderId}` : (url.searchParams.has("folder") ? `:${folder}` : "") + (folderId ? `:${folderId}` : "");
  if (!["inbox", "archive", "all", "trash"].includes(folder)) throw new HttpError(400, "invalid_filter");
  const taxonomy = serverFolderId ? { condition: "1", values: [] } : await normalTaxonomySelection(env, identity, { folder, ...(folderId ? { folderId } : {}) });
  const raw = url.searchParams.get("limit") ?? "20", cursor = url.searchParams.get("cursor");
  if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 20) throw new HttpError(400, "invalid_limit");
  let before = 4294967296;
  if (cursor) {
    const match = /^([0-9a-f-]{36}):([1-9]\d{0,9})((?::server:[0-9a-f]{64})|(?::(?:inbox|archive|all|trash))?(?::[0-9a-f-]{36})?)$/.exec(cursor);
    if (!match || match[1] !== context.epochId || (match[3] ?? "") !== suffix || Number(match[2]) > 4294967295) throw new HttpError(400, "invalid_cursor");
    before = Number(match[2]);
  }
  const rows = context.epochId ? (await env.DB.prepare(`SELECT m.*,${normalStateColumns} FROM normal_inbox_messages m JOIN normal_inbox_batches b ON b.id=m.batch_id ${normalStateJoin}
    WHERE m.account_id=? AND m.epoch_id=? AND m.uid<? AND m.purged_at IS NULL AND b.status='committed'
    AND b.account_id=m.account_id AND b.epoch_id=m.epoch_id AND b.source_hash=?
    ${separateFolderInbox(context) ? "AND m.server_folder_id=? AND b.server_folder_id=m.server_folder_id" : ""}
    AND ${serverFolderId ? "1" : normalFolderCondition(folder)} AND ${taxonomy.condition} ORDER BY m.uid DESC LIMIT ?`)
    .bind(accountId, context.epochId, before, separateFolderInbox(context) ? context.serverFolder!.sourceHash : await normalInboxSourceHash(context.account),
      ...(separateFolderInbox(context) ? [serverFolderId!] : []), ...taxonomy.values, Number(raw) + 1).all<NormalStoredMessage>()).results : [];
  const chosen = rows.slice(0, Number(raw)), items = [];
  for (const row of chosen) items.push({ ...await summary(env, row), ...(serverFolderId ? { serverFolderId } : {}) });
  await assertFolderInboxCurrent(env, identity, context);
  return { items, nextCursor: rows.length > chosen.length ? `${context.epochId}:${chosen.at(-1)!.uid}${suffix}` : null,
    epochId: context.epochId, accountRevision: context.account.revision, sourceReady: !!context.epochId, ...(serverFolderId ? { serverFolderId } : {}) };
}
export async function getNormalMessage(env: Env, identity: Identity, accountId: string, id: string, serverFolderId?: string) {
  const context = serverFolderId ? await folderInboxContext(env, identity, accountId, serverFolderId) : await normalInboxContext(env, identity, accountId);
  const row = await folderStoredMessage(env, context, id);
  const content = await normalContent(env, row);
  if (content.recipient !== context.account.email_address) throw new HttpError(503, "normal_content_unavailable");
  const message = { ...(await summary(env, row)), ...(serverFolderId ? { serverFolderId } : {}), accountRevision: context.account.revision, textBody: content.textBody, htmlBody: content.htmlBody,
    attachmentsTruncated: content.attachmentsTruncated, attachments: content.attachments.map(part => ({ filename: part.filename,
      size: part.size, downloadAvailable: downloadable(part) })) };
  await assertFolderInboxCurrent(env, identity, context); return { message };
}
