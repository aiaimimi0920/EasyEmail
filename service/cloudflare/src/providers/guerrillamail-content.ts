import { decodeHTML } from "entities";
import { HttpError } from "../http";
import { mailAddress } from "../mail-address";
import type { MailContent } from "./contracts";
import { object, optionalString, string } from "./http";

export function guerrillaToken(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value)) throw new HttpError(502, "provider_invalid_response");
  return value;
}

export function guerrillaId(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : string(value, 32);
  if (!/^[1-9][0-9]{0,31}$/.test(id)) throw new HttpError(502, "provider_invalid_response");
  return id;
}

export function guerrillaNumber(value: unknown): number {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HttpError(502, "provider_invalid_response");
  return value as number;
}

export function guerrillaAuth(row: Record<string, unknown>): void {
  if (row.auth === undefined) return;
  const auth = object(row.auth);
  if (auth.success !== true || !Array.isArray(auth.error_codes) || auth.error_codes.length) throw new HttpError(502, "provider_auth_failed");
}

export function guerrillaContent(value: unknown, id: string, address: string): MailContent {
  const row = object(value); guerrillaAuth(row);
  if (guerrillaId(row.mail_id) !== id) throw new HttpError(502, "provider_invalid_response");
  if (mailAddress(row.mail_recipient) !== address) throw new HttpError(502, "provider_recipient_mismatch");
  const mime = string(row.content_type, 128).split(";")[0].trim().toLowerCase(), body = optionalString(row, ["mail_body"]);
  if (!["text/plain", "text/html"].includes(mime)) throw new HttpError(502, "provider_invalid_response");
  const timestamp = guerrillaNumber(row.mail_timestamp);
  if (timestamp > 253402300799) throw new HttpError(502, "provider_invalid_response");
  return { remoteId: id, recipient: address, sender: optionalString(row, ["mail_from"], 2048), subject: decodeHTML(optionalString(row, ["mail_subject"], 4096)),
    textBody: mime === "text/plain" ? body : decodeHTML(optionalString(row, ["mail_excerpt"])), htmlBody: mime === "text/html" ? body : "",
    attachments: [], receivedAt: timestamp };
}
