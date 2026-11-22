import { unixNow } from "../contracts";
import { HttpError } from "../http";
import { mailAddress } from "../mail-address";
import type { MailContent } from "./contracts";
import { object, optionalString, receivedTime, string } from "./http";

export function im215Data(value: unknown): unknown {
  const row = object(value);
  if (row.success !== true || !Object.hasOwn(row, "data")) throw new HttpError(502, "provider_invalid_response");
  return row.data;
}

export function im215Id(value: unknown): string {
  const id = string(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(502, "provider_invalid_response");
  return id;
}

export function im215Token(value: unknown): string {
  const token = string(value, 4096);
  if (!/^[\x21-\x7e]+$/.test(token)) throw new HttpError(502, "provider_invalid_response");
  return token;
}

function expiry(value: unknown): number | null {
  if (value === null) return null;
  const time = receivedTime(value), raw = typeof value === "string" ? value : "";
  const [year, month, day] = raw.slice(0, 10).split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (time === null || time <= unixNow() || time > 253402300799 || month < 1 || month > 12 || day < 1 || day > days
    || Number(raw.slice(11, 13)) > 23) throw new HttpError(502, "provider_invalid_response");
  return time;
}

export function im215Account(value: unknown, id: string, address: string): number | null {
  const row = object(value);
  if (im215Id(row.id) !== id || row.isActive !== true || row.inboxType !== "temp") throw new HttpError(502, "provider_invalid_response");
  if (mailAddress(row.address) !== address) throw new HttpError(502, "provider_recipient_mismatch");
  return expiry(row.expiresAt);
}

export function im215Inbox(row: Record<string, unknown>, inboxId: string): void {
  if (im215Id(row.inboxId ?? row.inbox_id) !== inboxId || row.inbox_id !== undefined && im215Id(row.inbox_id) !== inboxId) throw new HttpError(502, "provider_recipient_mismatch");
  // Headers may omit a BCC delivery recipient. Ownership is the verified temp token and canonical inbox ID.
  if (!Array.isArray(row.to) || row.to.length > 100 || row.to.some(value => !mailAddress(object(value).address))) throw new HttpError(502, "provider_invalid_response");
}

export function im215Content(value: unknown, id: string, inboxId: string, address: string): MailContent {
  const row = object(value);
  if (im215Id(row.id) !== id) throw new HttpError(502, "provider_invalid_response");
  im215Inbox(row, inboxId);
  if (!Array.isArray(row.html) || row.html.length > 16 || !Array.isArray(row.attachments) || row.attachments.length > 100) throw new HttpError(502, "provider_invalid_response");
  const attachments = row.attachments.map(value => {
    const item = object(value), filename = string(item.filename, 255), size = item.size;
    if (!filename || /[\x00-\x1f\x7f]/.test(filename) || !Number.isSafeInteger(size) || (size as number) < 0) throw new HttpError(502, "provider_invalid_response");
    // downloadUrl can contain a bearer token. Never persist, return, or follow it.
    return { filename, size: size as number, mimeType: optionalString(item, ["contentType"], 255) || "application/octet-stream" };
  });
  return { remoteId: id, recipient: address, sender: optionalString(object(row.from), ["address"], 2048), subject: optionalString(row, ["subject"], 4096),
    textBody: string(row.text), htmlBody: string(row.html.map(value => string(value)).join("\n")), attachments,
    attachmentsTruncated: row.hasAttachments === true && attachments.length === 0, receivedAt: receivedTime(row.createdAt) };
}
