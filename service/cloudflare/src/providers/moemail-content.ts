import { HttpError } from "../http";
import { mailAddress } from "../mail-address";
import type { MailContent } from "./contracts";
import { object, optionalString } from "./http";

export function moemailId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new HttpError(502, "provider_invalid_response");
  return value;
}

export function moemailRecipient(row: Record<string, unknown>, address: string): void {
  if (mailAddress(row.to_address)?.toLowerCase() !== address) throw new HttpError(502, "provider_recipient_mismatch");
}

export function moemailContent(value: unknown, id: string, address: string): MailContent {
  const row = object(value);
  if (moemailId(row.id) !== id || (row.type !== "received" && row.type !== null)) throw new HttpError(502, "provider_invalid_response");
  moemailRecipient(row, address);
  const time = row.received_at;
  return { remoteId: id, sender: optionalString(row, ["from_address"], 2048), recipient: address,
    subject: optionalString(row, ["subject"], 4096), textBody: optionalString(row, ["content"]),
    htmlBody: optionalString(row, ["html"]), attachments: [],
    receivedAt: Number.isSafeInteger(time) && (time as number) >= 0 && (time as number) <= 8640000000000000 ? Math.floor((time as number) / 1000) : null };
}
