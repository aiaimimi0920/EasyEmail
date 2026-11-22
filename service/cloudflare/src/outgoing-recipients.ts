import { HttpError } from "./http";
import { mailAddress } from "./mail-address";

export interface RecipientFields { to: string | string[]; cc?: string[]; bcc?: string[] }
export interface Recipients extends RecipientFields { cc: string[]; bcc: string[] }
export const MAX_SEND_RECIPIENTS = 50;

export function parseRecipients(body: Record<string, unknown>, draft = false): Recipients {
  const error = () => new HttpError(400, draft ? "invalid_draft_request" : "invalid_send_request");
  const rawTo = typeof body.to === "string" ? [body.to] : body.to;
  const raw = [rawTo, body.cc === undefined ? [] : body.cc, body.bcc === undefined ? [] : body.bcc];
  if (raw.some(list => !Array.isArray(list)) || (Array.isArray(rawTo) && !rawTo.length)
    || raw.flat().length > MAX_SEND_RECIPIENTS) throw error();
  const seen = new Set<string>();
  const lists = (raw as unknown[][]).map((list, field) => list.flatMap(value => {
    const address = mailAddress(value);
    // Preserve the old ability to save an unfinished single-To draft, never send it.
    const partial = draft && field === 0 && typeof body.to === "string" && typeof value === "string"
      && value.length <= 254 && !/[\x00-\x1f\x7f]/.test(value);
    if (!address && !partial) throw error();
    const normalized = address ?? value as string, key = normalized.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key); return [normalized];
  }));
  if (!draft && !lists[0].length) throw error();
  return { to: lists[0].length > 1 ? lists[0] : lists[0][0] ?? "", cc: lists[1], bcc: lists[2] };
}

export const toList = (value: RecipientFields): string[] => typeof value.to === "string" ? (value.to ? [value.to] : []) : value.to;
export const allRecipients = (value: RecipientFields) => [...toList(value), ...(value.cc ?? []), ...(value.bcc ?? [])];
export const extendedRecipients = (value: RecipientFields) => toList(value).length > 1 || !!value.cc?.length || !!value.bcc?.length;
export const recipientsJson = (value: RecipientFields) => extendedRecipients(value)
  ? JSON.stringify({ to: value.to, cc: value.cc ?? [], bcc: value.bcc ?? [] }) : null;
export const storedRecipients = (row: { to_address: string; recipients_json?: string | null }): Recipients => row.recipients_json
  ? JSON.parse(row.recipients_json) : { to: row.to_address, cc: [], bcc: [] };

export function outgoingContentParts(mailboxId: string | null, value: RecipientFields, subject: string, text: string, reply: string | null) {
  const base: unknown[] = [mailboxId, value.to, subject, text, reply];
  // Empty optional lists and singleton To arrays canonicalize to the exact legacy hash.
  return extendedRecipients(value) ? [...base, { recipientsVersion: 1, cc: value.cc ?? [], bcc: value.bcc ?? [] }] : base;
}
