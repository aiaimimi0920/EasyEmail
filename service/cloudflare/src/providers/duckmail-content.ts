import { HttpError } from "../http";
import { mailAddress } from "../mail-address";
import type { MailContent } from "./contracts";
import { object, optionalString, receivedTime, string } from "./http";

export function duckmailId(value: unknown): string {
  const id = string(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(502, "provider_invalid_response");
  return id;
}

export function duckmailAccount(value: unknown, id: string, address: string): void {
  const row = object(value);
  if (duckmailId(row.id) !== id || row.source === "microsoft" || row.authType !== undefined && row.authType !== "email") throw new HttpError(502, "provider_invalid_response");
  if (mailAddress(row.address) !== address) throw new HttpError(502, "provider_recipient_mismatch");
}

export function duckmailRecipient(row: Record<string, unknown>, accountId: string, address: string): void {
  if (duckmailId(row.accountId) !== accountId) throw new HttpError(502, "provider_invalid_response");
  if (!Array.isArray(row.to) || row.to.length === 0 || row.to.length > 100) throw new HttpError(502, "provider_recipient_mismatch");
  const recipients = row.to.map(value => mailAddress(object(value).address));
  if (recipients.some(value => !value) || !recipients.includes(address)) throw new HttpError(502, "provider_recipient_mismatch");
}

export function duckmailContent(value: unknown, id: string, accountId: string, address: string): MailContent {
  const row = object(value);
  if (duckmailId(row.id) !== id) throw new HttpError(502, "provider_invalid_response");
  duckmailRecipient(row, accountId, address);
  const rawHtml = row.html ?? [], rawAttachments = row.attachments ?? [];
  if (!Array.isArray(rawHtml) || rawHtml.length > 16 || !Array.isArray(rawAttachments) || rawAttachments.length > 100) throw new HttpError(502, "provider_invalid_response");
  const html = string(rawHtml.map(value => string(value)).join("\n"));
  const attachments = rawAttachments.map(value => {
    const attachment = object(value), filename = string(attachment.filename, 255), size = attachment.size;
    if (!filename || /[\x00-\x1f\x7f]/.test(filename) || !Number.isSafeInteger(size) || (size as number) < 0) throw new HttpError(502, "provider_invalid_response");
    return { filename, size: size as number, mimeType: optionalString(attachment, ["contentType"], 255) || "application/octet-stream" };
  });
  return { remoteId: id, recipient: address, sender: optionalString(object(row.from), ["address"], 2048), subject: optionalString(row, ["subject"], 4096),
    textBody: optionalString(row, ["text"]), htmlBody: html, attachments,
    attachmentsTruncated: row.hasAttachments === true && attachments.length === 0, receivedAt: receivedTime(row.createdAt) };
}
