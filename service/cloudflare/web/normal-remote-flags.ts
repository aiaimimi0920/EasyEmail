import { api, ApiError } from "./api";
import { normalInboxPath, normalMessagePath, type NormalMail } from "./normal-inbox";

export type RemoteFlag = "\\Seen" | "\\Flagged";
export interface RemoteFlagBody { expectedRevision: number; epochId: string; flag: RemoteFlag; value: boolean; acknowledgedUnknownId: string | null }
export interface RemoteFlagAttempt { accountId: string; messageId: string; serverFolderId?: string; key: string; body: RemoteFlagBody }
export interface RemoteFlagOperation {
  id: string; accountId: string; messageId: string; accountRevision: number; epochId: string; uid: number;
  flag: RemoteFlag; value: boolean; acknowledgedUnknownId: string | null; requestKey: string;
  state: "pending" | "confirmed" | "failed" | "unknown"; remoteFlags: string[] | null; error: string | null; retrySafe: false;
  createdAt: number; dispatchedAt: number | null; finishedAt: number | null;
  serverFolderId?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function checkedRemoteFlag(value: unknown, accountId: string, messageId: string, attempt?: RemoteFlagAttempt, serverFolderId = attempt?.serverFolderId ?? ""): RemoteFlagOperation {
  const row = value as RemoteFlagOperation | null;
  if (!row || typeof row !== "object" || !uuid.test(row.id) || row.accountId !== accountId || row.messageId !== messageId || !uuid.test(row.epochId)
    || (row.serverFolderId !== undefined && (typeof row.serverFolderId !== "string" || !/^[0-9a-f]{64}$/.test(row.serverFolderId)))
    || (row.serverFolderId ?? "") !== serverFolderId
    || !Number.isSafeInteger(row.accountRevision) || row.accountRevision < 1 || !Number.isSafeInteger(row.uid) || row.uid < 1 || row.uid > 4294967295
    || !["\\Seen", "\\Flagged"].includes(row.flag) || typeof row.value !== "boolean" || row.retrySafe !== false
    || typeof row.requestKey !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(row.requestKey)
    || (row.acknowledgedUnknownId !== null && !uuid.test(row.acknowledgedUnknownId))
    || !["pending", "confirmed", "failed", "unknown"].includes(row.state) || !Number.isSafeInteger(row.createdAt)
    || (row.dispatchedAt !== null && !Number.isSafeInteger(row.dispatchedAt)) || (row.finishedAt !== null && !Number.isSafeInteger(row.finishedAt))
    || (row.remoteFlags !== null && (!Array.isArray(row.remoteFlags) || row.remoteFlags.length > 100 || row.remoteFlags.some(flag => typeof flag !== "string" || flag.length > 81)))
    || (row.error !== null && typeof row.error !== "string")
    || (row.state === "failed" && (row.dispatchedAt !== null || row.finishedAt === null || row.remoteFlags !== null || row.error === null))
    || (row.state === "pending" && (row.finishedAt !== null || row.remoteFlags !== null || row.error !== null))
    || (row.state === "unknown" && row.remoteFlags !== null)
    || (row.state === "confirmed" && (row.error !== null || row.dispatchedAt === null || row.finishedAt === null || row.remoteFlags === null
      || row.remoteFlags.some(flag => flag.toLowerCase() === row.flag.toLowerCase()) !== row.value))
    || (attempt && (row.requestKey !== attempt.key || row.accountRevision !== attempt.body.expectedRevision || row.epochId !== attempt.body.epochId
      || row.flag !== attempt.body.flag || row.value !== attempt.body.value || row.acknowledgedUnknownId !== attempt.body.acknowledgedUnknownId))) {
    throw new ApiError(502, "remote_flags_response_invalid");
  }
  return row;
}
export function remoteFlagRejectedBeforeReservation(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  const safe: Record<string, number> = {
    invalid_remote_flags_request: 400, idempotency_key_required: 400, insufficient_scope: 403, origin_denied: 403, not_found: 404,
    remote_flags_target_changed: 409, normal_account_disabled: 409, imap_endpoint_changed: 409,
    remote_flags_previous_unresolved: 409, remote_flags_changed_or_limit: 409, rate_limited: 429,
    normal_server_folder_not_current: 404, normal_server_folder_not_selectable: 409, remote_flags_folder_schema_required: 409,
  };
  return safe[error.message] === error.status;
}
export async function runRemoteFlag(attempt: RemoteFlagAttempt, readOnly: boolean) {
  const path = normalInboxPath(attempt.accountId, attempt.serverFolderId);
  const result = readOnly ? await api<{ operation: unknown }>(`${path}/remote-flag-operations/${attempt.key}`)
    : await api<{ operation: unknown }>(`${path}/messages/${attempt.messageId}/remote-flags`, "POST", attempt.body, { "idempotency-key": attempt.key });
  return checkedRemoteFlag(result.operation, attempt.accountId, attempt.messageId, attempt);
}
export async function latestRemoteFlag(message: NormalMail, signal: AbortSignal) {
  const result = await api<{ operation: unknown }>(`${normalMessagePath(message)}/remote-flags`, "GET", undefined, undefined, signal);
  return result.operation === null ? null : checkedRemoteFlag(result.operation, message.accountId, message.id, undefined, message.serverFolderId);
}
