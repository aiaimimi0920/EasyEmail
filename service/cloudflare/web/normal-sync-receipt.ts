import { ApiError } from "./api";
import type { NormalSyncRequest } from "./normal-inbox";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function checkedNormalSync(value: unknown, accountId: string, revision: number, key: string, serverFolderId: string) {
  const row = value as NormalSyncRequest | null, result = row?.result;
  const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
  if (!row || typeof row !== "object" || !uuid.test(row.id) || row.accountId !== accountId || row.requestKey !== key
    || row.accountRevision !== revision || (row.serverFolderId ?? "") !== serverFolderId
    || !["pending", "committed", "failed"].includes(row.state) || !integer(row.createdAt, 1)
    || (row.finishedAt !== null && !integer(row.finishedAt, 1)) || (row.errorCode !== null && typeof row.errorCode !== "string")
    || (row.state === "pending" && (row.finishedAt !== null || row.errorCode !== null || result !== null))
    || (row.state === "failed" && (row.errorCode === null || result !== null))
    || (row.state === "committed" && (row.errorCode !== null || row.finishedAt === null || !result
      || !integer(result.stored, 0, 3) || typeof result.complete !== "boolean" || typeof result.reset !== "boolean"
      || !result.cursor || !/^[1-9]\d{0,9}$/.test(result.cursor.uidValidity) || Number(result.cursor.uidValidity) > 4294967295
      || !integer(result.cursor.afterUid, 0, 4294967295) || !Array.isArray(result.skipped) || result.skipped.length > 3
      || result.skipped.some(item => !item || !integer(item.uid, 1, 4294967295) || !["message_missing", "message_too_large"].includes(item.reason))))) {
    throw new ApiError(502, "normal_sync_response_invalid");
  }
  return row;
}
export function normalSyncRejectedBeforeReservation(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  const safe: Record<string, number> = { invalid_normal_account_request: 400, idempotency_key_required: 400,
    insufficient_scope: 403, origin_denied: 403, normal_server_folder_not_current: 404, normal_server_folder_not_selectable: 409,
    normal_account_changed: 409, normal_account_disabled: 409, normal_inbox_changed_or_limit: 409, rate_limited: 429 };
  return safe[error.message] === error.status;
}
