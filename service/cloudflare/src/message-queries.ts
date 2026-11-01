import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions } from "./http";
import { requireScope } from "./identity";
import { ownedMailbox } from "./mailbox-sync";
import { MESSAGE_SUMMARY, messageView, type MessageStateRow } from "./message-view";
import { replyAddress } from "./mail-address";
import { downloadable } from "./attachment-policy";
import type { MailAttachment } from "./providers/contracts";
import { MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";

interface MessageRow {
  id: string; sender: string; recipient: string; subject: string;
  text_body: string; html_body: string; attachments: string; received_at: number | null;
}

export async function listMessages(request: Request, env: Env, identity: Identity, mailboxId: string): Promise<Response> {
  requireScope(identity, "messages:read");
  const mailbox = await ownedMailbox(env, identity, mailboxId);
  const { limit, cursor } = pageOptions(new URL(request.url));
  const { results } = await env.DB.prepare(`SELECT ${MESSAGE_SUMMARY} FROM messages m
    WHERE m.user_id = ? AND m.mailbox_id = ? AND m.trashed_at IS NULL AND m.purged_at IS NULL AND m.id > ? ORDER BY m.id LIMIT ?`)
    .bind(identity.userId, mailboxId, cursor, limit + 1).all<MessageStateRow>();
  const items = results.slice(0, limit);
  return json({ items: items.map(messageView), nextCursor: results.length > limit ? items.at(-1)!.id : null,
    sync: { syncedAt: mailbox.synced_at, error: mailbox.sync_error, nextPage: mailbox.next_page } });
}

export async function getMessage(env: Env, identity: Identity, mailboxId: string, id: string): Promise<Response> {
  requireScope(identity, "messages:read");
  const row = await env.DB.prepare(`SELECT ${MESSAGE_SUMMARY}, m.text_body, m.html_body, m.attachments, m.attachments_truncated, m.trashed_at,
    m.source_version,m.remote_delete_enabled,
    CASE WHEN EXISTS (SELECT 1 FROM mailboxes WHERE id = m.mailbox_id AND user_id = m.user_id AND status = 'active'
      AND disabled_at IS NULL AND released_at IS NULL AND ${MAILBOX_EXPIRY_FENCE}) THEN 1 ELSE 0 END AS mailbox_usable FROM messages m
    WHERE m.id = ? AND m.mailbox_id = ? AND m.user_id = ? AND m.purged_at IS NULL`).bind(id, mailboxId, identity.userId)
    .first<MessageRow & MessageStateRow & { attachments_truncated: number; trashed_at: number | null; mailbox_usable: number;
      source_version: string | null; remote_delete_enabled: number }>();
  if (!row) throw new HttpError(404, "not_found");
  const { text_body, html_body, attachments, attachments_truncated, trashed_at, mailbox_usable, source_version, remote_delete_enabled, ...summary } = row;
  const metadata = (JSON.parse(attachments) as MailAttachment[]).map((item) => ({ ...item, downloadAvailable: mailbox_usable === 1 && downloadable(item) }));
  return json({ message: { ...messageView(summary), textBody: text_body, htmlBody: html_body,
    replyAddress: trashed_at === null && mailbox_usable === 1 ? replyAddress(row.sender) : null, trashedAt: trashed_at,
    attachments: metadata, attachmentsTruncated: attachments_truncated === 1,
    remoteDeleteAvailable: mailbox_usable === 1 && trashed_at !== null && !!source_version && remote_delete_enabled === 1,
    attachmentDownloadAvailable: metadata.some((item) => item.downloadAvailable) } });
}
