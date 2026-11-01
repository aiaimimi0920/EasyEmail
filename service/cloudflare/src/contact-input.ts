import { HttpError, readJson } from "./http";
import { replyAddress } from "./mail-address";

export const CONTACT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface ContactFields { displayName?: string; emailAddress?: string; note?: string | null }
export interface ContactCommand { kind: "POST" | "PATCH" | "DELETE"; targetId: string | null; expectedVersion?: number; fields: ContactFields }
export const contactNameKey = (name: string) => name.replace(/[A-Z]/g, character => character.toLowerCase());
export const defaultContactName = (email: string) => email[0].toUpperCase() + email.slice(1, email.indexOf("@"));
const invalid = () => new HttpError(400, "invalid_contact_request");

export async function contactCommand(request: Request, targetId: string | null): Promise<ContactCommand> {
  const body = await readJson(request), kind = request.method as ContactCommand["kind"], fields: ContactFields = {};
  const allowed = kind === "POST" ? ["displayName", "emailAddress", "note"] : kind === "PATCH"
    ? ["displayName", "emailAddress", "note", "expectedVersion"] : ["expectedVersion"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw invalid();
  if (Object.hasOwn(body, "emailAddress")) {
    if (typeof body.emailAddress !== "string" || body.emailAddress.length > 512 || /[\p{Cc}\p{Cf}]/u.test(body.emailAddress)) throw invalid();
    const email = replyAddress(body.emailAddress.trim());
    if (!email) throw invalid();
    fields.emailAddress = email.toLowerCase();
  }
  if (Object.hasOwn(body, "displayName")) {
    if (typeof body.displayName !== "string" || body.displayName.length > 320 || /[\p{Cc}\p{Cf}]/u.test(body.displayName)) throw invalid();
    fields.displayName = body.displayName.normalize("NFC").trim();
    if ([...fields.displayName].length > 80) throw invalid();
  }
  if (Object.hasOwn(body, "note")) {
    if (body.note !== null && (typeof body.note !== "string" || body.note.length > 2000 || /[\p{Cc}\p{Cf}]/u.test(body.note.replace(/[\r\n\t]/g, "")))) throw invalid();
    fields.note = typeof body.note === "string" ? body.note.trim() || null : null;
  }
  if (kind === "POST") {
    if (!fields.emailAddress) throw invalid();
    return { kind, targetId, fields: { displayName: fields.displayName || defaultContactName(fields.emailAddress), emailAddress: fields.emailAddress, note: fields.note ?? null } };
  }
  const version = body.expectedVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) >= Number.MAX_SAFE_INTEGER
    || (kind === "PATCH" && !Object.keys(fields).length)) throw invalid();
  return { kind, targetId, expectedVersion: version as number, fields };
}
