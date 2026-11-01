import type { Env } from "./contracts";
import { HttpError, textField } from "./http";
import { mailAddress } from "./mail-address";
import { tokenHash } from "./security";

export interface ImapEndpoint { id: string; label: string; hostname: string; port: 993 | 143; security?: "tls" | "starttls"; authentication?: "password" | "google-oauth2" }
export function imapEndpoints(env: Env): ImapEndpoint[] {
  try {
    const items: unknown = JSON.parse(env.IMAP_ENDPOINTS ?? "[]");
    if (!Array.isArray(items) || items.length > 20) throw new Error();
    const ids = new Set();
    for (const row of items) {
      if (!row || Object.keys(row).some(key => !["id", "label", "hostname", "port", "security", "authentication"].includes(key))
        || (row.authentication !== undefined && !["password", "google-oauth2"].includes(row.authentication))
        || (row.authentication === "google-oauth2" && (row.hostname !== "imap.gmail.com" || row.port !== 993))
        || typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(row.id) || ids.has(row.id)
        || typeof row.label !== "string" || !row.label.trim() || row.label.length > 80 || /[\x00-\x1f\x7f]/.test(row.label)
        || typeof row.hostname !== "string" || row.hostname.length > 253 || row.hostname !== row.hostname.toLowerCase()
        || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(row.hostname)
        || /(?:\.home\.arpa$|(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|onion|invalid)$)/.test(row.hostname)
        || !(row.port === 993 && (row.security === undefined || row.security === "tls")
          || row.port === 143 && row.security === "starttls")) throw new Error();
      ids.add(row.id);
    }
    return items as ImapEndpoint[];
  } catch { throw new HttpError(503, "imap_endpoints_unavailable"); }
}
export async function imapEndpoint(env: Env, id: string) {
  const endpoint = imapEndpoints(env).find(row => row.id === id);
  if (!endpoint) throw new HttpError(409, "imap_endpoint_unavailable");
  return { ...endpoint, hash: await tokenHash(JSON.stringify([endpoint.authentication === "google-oauth2" ? "imap-google-oauth2-v1"
    : endpoint.security === "starttls" ? "imap-starttls-v1" : "imap-tls-v1", endpoint.hostname, endpoint.port])) };
}
export function normalRevision(body: Record<string, unknown>) {
  const revision = body.expectedRevision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || (revision as number) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "invalid_normal_account_request");
  return revision as number;
}
export function normalAccountInput(body: Record<string, unknown>, deleting: boolean) {
  const expectedRevision = normalRevision(body);
  if (Object.keys(body).some(key => !(deleting ? ["expectedRevision"] : ["expectedRevision", "emailAddress", "displayName", "endpointId", "username", "password", "enabled", "forgetCredential"]).includes(key))) throw new HttpError(400, "invalid_normal_account_request");
  if (deleting) return { expectedRevision, deleting, fields: null };
  const field = (key: string, min: number, max: number) => {
    try { return textField(body, key, min, max); } catch { throw new HttpError(400, "invalid_normal_account_request"); }
  };
  const emailAddress = field("emailAddress", 3, 254).toLowerCase();
  const displayName = field("displayName", 0, 100), endpointId = field("endpointId", 1, 32), username = field("username", 1, 255);
  const roundTrips = (value: string) => new TextDecoder().decode(new TextEncoder().encode(value)) === value;
  if (!mailAddress(emailAddress) || /[\x00-\x1f\x7f]/.test(displayName + username) || typeof body.enabled !== "boolean"
    || (body.forgetCredential !== undefined && typeof body.forgetCredential !== "boolean")
    || (body.password !== undefined && (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 1024 || /[\x00-\x1f\x7f]/.test(body.password)))
    || !roundTrips(username) || !roundTrips(displayName) || (typeof body.password === "string" && !roundTrips(body.password))
    || (body.forgetCredential && (body.password !== undefined || body.enabled))) throw new HttpError(400, "invalid_normal_account_request");
  return { expectedRevision, deleting, fields: { emailAddress, displayName, endpointId, username, password: body.password as string | undefined,
    enabled: body.enabled, forgetCredential: body.forgetCredential === true } };
}
export type NormalAccountCommand = ReturnType<typeof normalAccountInput>;
