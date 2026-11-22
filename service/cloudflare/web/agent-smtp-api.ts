import { ApiError } from "./api";
import type { AgentAccount } from "./agent-accounts-api";

export interface AgentSmtpConfig {
  accountId: string; scope: "agent"; authentication: "password" | "google-oauth2"; parentRevision: number; accountRevision: number; revision: number;
  endpointId: string; username: string; credentialConfigured: boolean; enabled: boolean; current: boolean; updatedAt: number | null;
}
export interface AgentSmtpEndpoint { id: string; label: string; hostname: string; port: 465 | 587; security: "tls" | "starttls"; authentication: "password" | "google-oauth2" }
export interface AgentSmtpAttempt { id: string; key: string; body: Record<string, unknown>; uncertain: boolean }
export interface AgentSmtpReceipt { requestKey: string; accountId: string; kind: "PUT"; accountRevision: number; revision: number; completedAt: number }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= Number.MAX_SAFE_INTEGER;
export function readAgentSmtpReceipt(value: unknown, attempt: Pick<AgentSmtpAttempt, "id" | "key" | "body">): AgentSmtpReceipt {
  const row = object(object(value)?.operation);
  if (!row || row.accountId !== attempt.id || row.requestKey !== attempt.key || row.kind !== "PUT"
    || row.accountRevision !== attempt.body.expectedRevision || !integer(row.revision, 1) || row.revision !== Number(attempt.body.smtpRevision) + 1
    || !integer(row.completedAt, 0)) throw new ApiError(502, "agent_smtp_receipt_invalid");
  return row as unknown as AgentSmtpReceipt;
}
export function readAgentSmtpConfig(value: unknown, account: Pick<AgentAccount, "id" | "revision"> & Partial<Pick<AgentAccount, "authentication">>): AgentSmtpConfig {
  const row = object(object(value)?.smtp), invalid = () => new ApiError(502, "agent_smtp_response_invalid");
  if (!row || row.accountId !== account.id || row.scope !== "agent" || row.authentication !== (account.authentication ?? "password")
    || !integer(row.revision, 0) || !integer(row.accountRevision, 1) || !integer(row.parentRevision, 1)
    || typeof row.endpointId !== "string" || row.endpointId.length > 32 || typeof row.username !== "string" || row.username.length > 255
    || typeof row.credentialConfigured !== "boolean" || typeof row.enabled !== "boolean" || typeof row.current !== "boolean"
    || (row.enabled && !row.credentialConfigured)) throw invalid();
  if (row.parentRevision !== account.revision) throw new ApiError(409, "agent_account_changed");
  if (row.current !== (row.revision > 0 && row.accountRevision === account.revision)
    || (row.revision === 0 ? row.updatedAt !== null || row.endpointId !== "" || row.username !== "" || row.enabled || row.credentialConfigured
      : !integer(row.updatedAt, 0) || !/^[a-z][a-z0-9-]{0,31}$/.test(row.endpointId))) throw invalid();
  return row as unknown as AgentSmtpConfig;
}
export function readAgentSmtpEndpoints(value: unknown): AgentSmtpEndpoint[] {
  const rows = object(value)?.items, ids = new Set();
  if (!Array.isArray(rows) || rows.length > 20 || rows.some(value => {
    const row = object(value);
    if (!row || typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(row.id) || ids.has(row.id)
      || typeof row.label !== "string" || !row.label.length || row.label.length > 80 || typeof row.hostname !== "string" || row.hostname.length > 253
      || !["password", "google-oauth2"].includes(row.authentication as string)
      || row.authentication === "google-oauth2" && row.hostname !== "smtp.gmail.com"
      || !(row.port === 465 && row.security === "tls" || row.port === 587 && row.security === "starttls")) return true;
    ids.add(row.id); return false;
  })) throw new ApiError(502, "agent_smtp_response_invalid");
  return rows as AgentSmtpEndpoint[];
}
