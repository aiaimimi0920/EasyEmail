import type { Env, Identity } from "./contracts";
import { attachmentDisposition, downloadable } from "./attachment-policy";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import { ownedMailbox } from "./mailbox-sync";
import { decryptCredential } from "./mailbox-vault";
import type { MailAttachment } from "./providers/contracts";
import { configuredProvider, connectProvider } from "./providers/registry";
import { rateLimit } from "./rate-limits";
import { assertMailboxUsable } from "./mailbox-access";
import { assertProviderRevision } from "./providers/settings";

export async function downloadAttachment(env: Env, identity: Identity, mailboxId: string, messageId: string, index: number): Promise<Response> {
  requireScope(identity, "attachments:read");
  const mailbox = await ownedMailbox(env, identity, mailboxId);
  const row = await env.DB.prepare(`SELECT remote_id, attachments FROM messages WHERE id = ? AND mailbox_id = ? AND user_id = ? AND purged_at IS NULL`)
    .bind(messageId, mailboxId, identity.userId).first<{ remote_id: string; attachments: string }>();
  if (!row) throw new HttpError(404, "not_found");
  const attachment = (JSON.parse(row.attachments) as MailAttachment[])[index];
  if (!attachment) throw new HttpError(404, "not_found");
  assertMailboxUsable(mailbox);
  if (!downloadable(attachment)) throw new HttpError(409, "attachment_not_verifiable");
  const config = await configuredProvider(env, mailbox.provider_id);
  const provider = await connectProvider(env, config);
  if (!provider.attachment) throw new HttpError(409, "attachment_download_unsupported");
  const credential = await decryptCredential(env, mailbox, mailbox.credential_cipher);
  await rateLimit(env, "attachment-download", identity.userId, 10);
  await rateLimit(env, "attachment-download-global", "platform", 100);
  const bytes = await provider.attachment(mailbox.address, credential, row.remote_id, attachment);
  assertMailboxUsable(await ownedMailbox(env, identity, mailboxId));
  await assertProviderRevision(env, config);
  if (!await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND user_id = ? AND purged_at IS NULL")
    .bind(messageId, identity.userId).first()) throw new HttpError(404, "not_found");
  return new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength),
    "content-disposition": attachmentDisposition(attachment.filename) } });
}
