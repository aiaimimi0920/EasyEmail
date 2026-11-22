import { ApiError, type Page } from "./api";
import type { AgentAccount } from "./agent-accounts-api";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function readAgentSenderAccount(value: unknown, expectedId?: string): AgentAccount {
  const row = value as AgentAccount;
  if (!row || typeof row !== "object" || Array.isArray(row) || !uuid(row.id) || expectedId !== undefined && row.id !== expectedId
    || row.scope !== "agent" || row.kind !== "agent_owned" || !["password", "google-oauth2"].includes(row.authentication)
    || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.enabled !== "boolean" || typeof row.credentialConfigured !== "boolean"
    || ![row.emailAddress, row.displayName, row.endpointId, row.username].every(item => typeof item === "string")) throw new ApiError(502, "agent_sender_response_invalid");
  return row;
}
export function readAgentSenderPage(value: unknown): Page<AgentAccount> {
  const row = value as Page<unknown>;
  if (!row || !Array.isArray(row.items) || row.items.length > 100 || row.nextCursor !== null && !uuid(row.nextCursor)) throw new ApiError(502, "agent_sender_response_invalid");
  const items = row.items.map(item => readAgentSenderAccount(item));
  if (new Set(items.map(item => item.id)).size !== items.length) throw new ApiError(502, "agent_sender_response_invalid");
  return { items, nextCursor: row.nextCursor };
}
