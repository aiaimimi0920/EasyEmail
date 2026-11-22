import { unixNow, type Env } from "./contracts";
import type { OwnedMailbox } from "./mailbox-sync";
import type { MailContent } from "./providers/contracts";
import { tokenHash } from "./security";
import { MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";
import { messageThreadPlan } from "./message-thread-input";
import { threadWriteStatements } from "./message-thread-store";
import { subscriptionPlan } from "./subscription-input";
import { subscriptionWriteStatements } from "./subscription-cache";

export async function mailCacheStatements(env: Env, row: OwnedMailbox, mail: MailContent, lease: string) {
  const { rfcMessageId, threadHeaders, subscriptionHeaders, attachmentsTruncated, resourceVersion, remoteDeleteEnabled, ...legacy } = mail;
  legacy.attachments = mail.attachments.map(({ index: _index, sha256: _sha256, ...item }) => item);
  const fingerprint = await tokenHash(JSON.stringify(legacy));
  const version = mail.attachments.some((item) => item.sha256)
    ? await tokenHash(JSON.stringify(mail.attachments.map((item) => item.sha256 ?? null))) : null;
  const versionFingerprint = version ? await tokenHash(JSON.stringify([fingerprint, version])) : fingerprint;
  const attachments = JSON.stringify(mail.attachments);
  const fence = `EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ? AND paused = 0
    AND status = 'active' AND disabled_at IS NULL AND released_at IS NULL AND sync_token = ? AND sync_lease_until > unixepoch() AND ${MAILBOX_EXPIRY_FENCE})`;
  const plan = await messageThreadPlan({ ...mail, threadHeaders });
  const subscription = await subscriptionPlan(mail.sender, subscriptionHeaders);
  const metadata = (predicate: string, values: (string | null)[]) => {
    const target = { where: `m.user_id=? AND m.mailbox_id=? AND (${predicate}) AND ${fence}`, values: [row.user_id, row.id, ...values, row.id, row.user_id, lease] };
    return [...threadWriteStatements(env, row.user_id, row.id, target, plan), ...subscriptionWriteStatements(env, row.user_id, row.id, target, subscription)];
  };
  if (resourceVersion) {
    // Never upgrade a historical body match to a newly observed source generation.
    const sourceFingerprint = await tokenHash(JSON.stringify(["source-v1", fingerprint, version, resourceVersion]));
    return [env.DB.prepare(`UPDATE messages SET remote_delete_enabled=? WHERE mailbox_id=? AND user_id=? AND fingerprint=?
      AND source_version=? AND purged_at IS NULL AND ${fence}`)
      .bind(Number(remoteDeleteEnabled === true), row.id, row.user_id, sourceFingerprint, resourceVersion, row.id, row.user_id, lease),
    env.DB.prepare(`INSERT INTO messages
      (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at,
        rfc_message_id,attachment_version,attachments_truncated,source_version,remote_delete_enabled)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence} ON CONFLICT(mailbox_id,fingerprint) DO NOTHING`)
      .bind(crypto.randomUUID(), row.user_id, row.id, mail.remoteId, sourceFingerprint, mail.sender, mail.recipient, mail.subject,
        mail.textBody, mail.htmlBody, attachments, mail.receivedAt, unixNow(), rfcMessageId ?? null, version,
        Number(!!attachmentsTruncated), resourceVersion, Number(remoteDeleteEnabled === true), row.id, row.user_id, lease),
      ...metadata("m.fingerprint=? AND m.source_version=?", [sourceFingerprint, resourceVersion])];
  }
  // Keep the first legacy identity stable for old readers/writers; binary changes get separate versions.
  const update = env.DB.prepare(`UPDATE messages SET attachments = ?, rfc_message_id = COALESCE(rfc_message_id, ?),
    attachment_version = ?, attachments_truncated = ? WHERE purged_at IS NULL AND mailbox_id = ? AND user_id = ? AND
    ((fingerprint = ? AND (attachment_version IS NULL OR attachment_version IS ?)) OR
      (fingerprint = ? AND attachment_version IS ?)) AND ${fence}`)
    .bind(attachments, rfcMessageId ?? null, version, Number(!!attachmentsTruncated), row.id, row.user_id,
      fingerprint, version, versionFingerprint, version, row.id, row.user_id, lease);
  const insert = env.DB.prepare(`INSERT INTO messages
    (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,
      received_at,observed_at,rfc_message_id,attachment_version,attachments_truncated)
    SELECT ?,?,?,?, CASE WHEN EXISTS (SELECT 1 FROM messages WHERE mailbox_id = ? AND fingerprint = ?)
      THEN ? ELSE ? END, ?,?,?,?,?,?,?,?,?,?,? WHERE ${fence} AND NOT EXISTS
      (SELECT 1 FROM messages WHERE mailbox_id = ? AND (fingerprint = ? OR
        (fingerprint = ? AND (attachment_version IS ? OR ? IS NULL))))
    ON CONFLICT(mailbox_id, fingerprint) DO NOTHING`)
    .bind(crypto.randomUUID(), row.user_id, row.id, mail.remoteId, row.id, fingerprint, versionFingerprint, fingerprint,
      mail.sender, mail.recipient, mail.subject, mail.textBody, mail.htmlBody, attachments, mail.receivedAt, unixNow(),
      rfcMessageId ?? null, version, Number(!!attachmentsTruncated), row.id, row.user_id, lease,
      row.id, versionFingerprint, fingerprint, version, version);
  return [update, insert, ...metadata("m.source_version IS NULL AND m.fingerprint IN (?,?) AND (m.attachment_version IS ? OR ? IS NULL)",
    [fingerprint, versionFingerprint, version, version])];
}
