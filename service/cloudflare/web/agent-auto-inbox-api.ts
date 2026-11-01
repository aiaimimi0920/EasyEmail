import { api, ApiError } from "./api";
export interface AutoInboxConfig {
  accountId: string; accountRevision: number; revision: number; boundAccountRevision: number; enabled: boolean; intervalMinutes: number; ready: boolean;
  nextDueAt: number | null; lastState: "idle" | "running" | "committed" | "failed" | "interrupted"; lastErrorCode: string | null;
  lastRequestKey: string | null; lastStartedAt: number | null; lastFinishedAt: number | null;
}
export interface AutoInboxInput { expectedAccountRevision: number; expectedRevision: number; enabled: boolean; intervalMinutes: number; persistentAuthorization: boolean }
export interface AutoInboxAttempt { accountId: string; key: string; body: AutoInboxInput; uncertain: boolean }
export interface AutoInboxReceipt { id: string; accountId: string; requestKey: string; accountRevision: number; expectedRevision: number;
  revision: number; enabled: boolean; intervalMinutes: number; persistentAuthorization: boolean; completedAt: number }
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const invalid = () => new ApiError(502, "agent_auto_inbox_response_invalid");
export function readAutoInboxConfig(value: unknown, account: { id: string; revision: number }): AutoInboxConfig {
  const row = object(object(value)?.config);
  if (!row || row.accountId !== account.id || row.accountRevision !== account.revision || !integer(row.revision) || !integer(row.boundAccountRevision)
    || typeof row.enabled !== "boolean" || typeof row.ready !== "boolean" || ![5, 15, 60].includes(row.intervalMinutes as number)
    || typeof row.lastState !== "string" || !["idle", "running", "committed", "failed", "interrupted"].includes(row.lastState)
    || row.ready && (!row.enabled || row.boundAccountRevision !== row.accountRevision)
    || [row.nextDueAt, row.lastStartedAt, row.lastFinishedAt].some(value => value !== null && !integer(value))
    || row.lastRequestKey !== null && !uuid(row.lastRequestKey)
    || row.lastErrorCode !== null && (typeof row.lastErrorCode !== "string" || row.lastErrorCode.length > 256)
    || row.revision === 0 && (row.enabled || row.boundAccountRevision !== 0 || row.lastState !== "idle")) throw invalid();
  return row as unknown as AutoInboxConfig;
}
export function readAutoInboxReceipt(value: unknown, attempt: AutoInboxAttempt): AutoInboxReceipt {
  const row = object(object(value)?.operation), body = attempt.body;
  if (!row || !uuid(row.id) || row.accountId !== attempt.accountId || row.requestKey !== attempt.key || row.accountRevision !== body.expectedAccountRevision
    || row.expectedRevision !== body.expectedRevision || row.revision !== body.expectedRevision + 1 || row.enabled !== body.enabled
    || row.intervalMinutes !== body.intervalMinutes || row.persistentAuthorization !== body.persistentAuthorization || !integer(row.completedAt)) throw invalid();
  return row as unknown as AutoInboxReceipt;
}
export const fetchAutoInbox = async (account: { id: string; revision: number }) => readAutoInboxConfig(await api(`/agent-accounts/${account.id}/auto-inbox`), account);
