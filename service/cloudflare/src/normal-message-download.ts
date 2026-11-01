import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import { attachmentDisposition, downloadable } from "./attachment-policy";
import { normalInboxContext, normalStoredMessage, assertNormalInboxCurrent } from "./normal-inbox-access";
import { normalContent, normalObject } from "./normal-inbox-objects";
import { normalMimeHash, parseNormalMimeParts } from "./normal-mime-content";
import { rateLimit } from "./rate-limits";
import { folderInboxContext, assertFolderInboxCurrent, folderStoredMessage } from "./normal-folder-inbox-access";

export async function downloadNormalMessage(env: Env, identity: Identity, accountId: string, id: string, index: number | null, serverFolderId?: string) {
  requireScope(identity, "attachments:read");
  const context = serverFolderId ? await folderInboxContext(env, identity, accountId, serverFolderId) : await normalInboxContext(env, identity, accountId);
  const row = await folderStoredMessage(env, context, id);
  if (index !== null && (!Number.isInteger(index) || index < 0 || index > 99)) throw new HttpError(404, "not_found");
  const content = index === null ? null : await normalContent(env, row), expected = index === null ? null : content!.attachments[index];
  if (index !== null && (!expected || !downloadable(expected))) throw new HttpError(404, "not_found");
  await rateLimit(env, "attachment-download", identity.userId, 10); await rateLimit(env, "attachment-download-global", "platform", 100);
  const raw = await normalObject(env, row.raw_key, row.raw_bytes, row.raw_sha256);
  let bytes = raw, filename = "message.eml";
  if (expected) {
    const parsed = await parseNormalMimeParts(raw), part = parsed.attachments[index!];
    if (!part || typeof part.content === "string") throw new HttpError(409, "attachment_source_changed");
    bytes = part.content instanceof Uint8Array ? new Uint8Array(part.content) : new Uint8Array(part.content);
    if (bytes.length !== expected.size || await normalMimeHash(bytes) !== expected.sha256) throw new HttpError(409, "attachment_source_changed");
    filename = expected.filename;
  }
  await assertFolderInboxCurrent(env, identity, context);
  return new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length),
    "content-disposition": attachmentDisposition(filename) } });
}
