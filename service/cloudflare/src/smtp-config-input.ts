import type { Env } from "./contracts";
import { HttpError, textField } from "./http";
import { mailAddress } from "./mail-address";
import { normalRevision } from "./normal-account-input";
import { tokenHash } from "./security";

export interface SmtpEndpoint { id: string; label: string; hostname: string; port: 465 | 587; security?: "tls" | "starttls"; recipients: string[]; authentication?: "password" | "google-oauth2" }
export function smtpEndpoints(env: Env): SmtpEndpoint[] {
  try {
    const rows: unknown = JSON.parse(env.SMTP_ENDPOINTS ?? "[]");
    if (!Array.isArray(rows) || rows.length > 20) throw new Error();
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || Object.keys(row).some(key => !["id", "label", "hostname", "port", "security", "recipients", "authentication"].includes(key))
        || (row.authentication !== undefined && !["password", "google-oauth2"].includes(row.authentication))
        || (row.authentication === "google-oauth2" && row.hostname !== "smtp.gmail.com")
        || typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(row.id) || ids.has(row.id)
        || typeof row.label !== "string" || !row.label.trim() || row.label.length > 80 || /[\x00-\x1f\x7f]/.test(row.label)
        || typeof row.hostname !== "string" || row.hostname.length > 253 || row.hostname !== row.hostname.toLowerCase()
        || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(row.hostname)
        || /(?:\.home\.arpa$|(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|onion|invalid)$)/.test(row.hostname)
        || !(row.port === 465 && (row.security === undefined || row.security === "tls") || row.port === 587 && row.security === "starttls")
        || !Array.isArray(row.recipients) || !row.recipients.length || row.recipients.length > 50
        || row.recipients.some((value: unknown) => value !== "*" && (!mailAddress(value) || value !== (value as string).toLowerCase()))
        || new Set(row.recipients).size !== row.recipients.length || (row.recipients.includes("*") && row.recipients.length !== 1)) throw new Error();
      ids.add(row.id);
    }
    return rows as SmtpEndpoint[];
  } catch { throw new HttpError(503, "smtp_endpoints_unavailable"); }
}
export async function smtpEndpoint(env: Env, id: string) {
  const endpoint = smtpEndpoints(env).find(row => row.id === id);
  if (!endpoint) throw new HttpError(409, "smtp_endpoint_unavailable");
  return { ...endpoint, hash: await tokenHash(JSON.stringify([endpoint.authentication === "google-oauth2" ? "smtp-google-oauth2-v1"
    : endpoint.security === "starttls" ? "smtp-starttls-plain-v1" : "smtp-tls-plain-v1", endpoint.hostname, endpoint.port, endpoint.recipients])) };
}
export function smtpRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "invalid_smtp_request");
  return value as number;
}
export function smtpConfigInput(body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !["expectedRevision", "smtpRevision", "endpointId", "username", "password", "enabled", "forgetCredential"].includes(key))) throw new HttpError(400, "invalid_smtp_request");
  const expectedRevision = normalRevision(body), revision = smtpRevision(body.smtpRevision);
  const endpointId = textField(body, "endpointId", 1, 32), username = textField(body, "username", 1, 255);
  const password = body.password;
  const valid = (value: string) => !/[\x00-\x1f\x7f]/.test(value) && new TextDecoder().decode(new TextEncoder().encode(value)) === value;
  if (!valid(username) || typeof body.enabled !== "boolean" || (body.forgetCredential !== undefined && typeof body.forgetCredential !== "boolean")
    || (password !== undefined && (typeof password !== "string" || !password.length || password.length > 1024 || !valid(password)))
    || (body.forgetCredential && (body.enabled || password !== undefined))) throw new HttpError(400, "invalid_smtp_request");
  return { expectedRevision, revision, endpointId, username, password: password as string | undefined, enabled: body.enabled, forgetCredential: body.forgetCredential === true };
}
