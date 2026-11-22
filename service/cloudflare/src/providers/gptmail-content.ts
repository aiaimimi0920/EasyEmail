import { HttpError } from "../http";
import type { MailContent } from "./contracts";
import { object, optionalString, receivedTime, string } from "./http";

export function gptmailData(value: unknown): Record<string, unknown> {
  const row = object(value);
  if (row.success !== true) throw new HttpError(502, "provider_invalid_response");
  return object(row.data);
}

export function gptmailId(value: unknown): string {
  const id = string(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(502, "provider_invalid_response");
  return id;
}

export function gptmailRecipient(row: Record<string, unknown>, address: string): void {
  if (string(row.email_address, 254).toLowerCase() !== address) throw new HttpError(502, "provider_recipient_mismatch");
}

export function gptmailContent(value: unknown, id: string, address: string): MailContent {
  const row = gptmailData(value);
  if (gptmailId(row.id) !== id) throw new HttpError(502, "provider_invalid_response");
  gptmailRecipient(row, address);
  if (row.timestamp !== undefined && (!Number.isSafeInteger(row.timestamp) || (row.timestamp as number) < 0 || (row.timestamp as number) > 253402300799)) {
    throw new HttpError(502, "provider_invalid_response");
  }
  return { remoteId: id, recipient: address, sender: optionalString(row, ["from_address"], 2048),
    subject: optionalString(row, ["subject"], 4096), textBody: optionalString(row, ["content"]),
    htmlBody: optionalString(row, ["html_content"]), attachments: [],
    receivedAt: receivedTime(row.created_at) ?? (row.timestamp as number | undefined) ?? null };
}
