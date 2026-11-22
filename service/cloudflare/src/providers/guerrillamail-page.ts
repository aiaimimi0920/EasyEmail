import { HttpError } from "../http";
import { mailAddress } from "../mail-address";
import { object } from "./http";
import { guerrillaAuth, guerrillaId, guerrillaNumber, guerrillaToken } from "./guerrillamail-content";

export function guerrillaCursor(page: number, value?: string): string | undefined {
  if (page === 1) return undefined;
  if (typeof value !== "string" || !/^guerrilla-older-v1:[1-9][0-9]{0,31}$/.test(value)) throw new HttpError(409, "provider_cursor_unavailable");
  return value.slice("guerrilla-older-v1:".length);
}

export function guerrillaPage(value: unknown, address: string, below?: string) {
  const row = object(value); guerrillaAuth(row);
  if (mailAddress(row.email) !== address) throw new HttpError(409, "provider_session_changed");
  const token = guerrillaToken(row.sid_token), count = guerrillaNumber(row.count), values = row.list;
  if (!Array.isArray(values) || values.length > 20 || count < values.length ||
    below === undefined && values.length === 0 && count !== 0) throw new HttpError(502, "provider_invalid_response");
  const seen = new Set<string>(); let oldest: string | null = null;
  const rows = values.map(value => {
    const mail = object(value), id = guerrillaId(mail.mail_id);
    if (seen.has(id) || below !== undefined && BigInt(id) >= BigInt(below)) throw new HttpError(502, "provider_invalid_response");
    seen.add(id); if (oldest === null || BigInt(id) < BigInt(oldest)) oldest = id;
    return { mail, id };
  });
  // Counts and documented offset page sizes disagree. Only an empty older tail terminates enumeration.
  return { rows, token, nextCursor: oldest === null ? null : `guerrilla-older-v1:${oldest}` };
}
