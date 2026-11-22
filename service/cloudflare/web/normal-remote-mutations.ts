import { api, ApiError } from "./api";
import { normalInboxPath, normalMessagePath, type NormalMail, type NormalMailPage } from "./normal-inbox";
import type { NormalAccount } from "./normal-accounts";
import { serverFolders, type ServerFolder } from "./normal-server-folders";
import { checkedRemoteMutation, type RemoteMutationAttempt } from "./normal-remote-mutation-model";

export async function runRemoteMutation(attempt: RemoteMutationAttempt, readOnly: boolean) {
  const path = normalInboxPath(attempt.accountId, attempt.serverFolderId);
  const result = readOnly ? await api<{ operation: unknown }>(`${path}/remote-mutation-operations/${attempt.key}`)
    : await api<{ operation: unknown }>(`${path}/messages/${attempt.messageId}/remote-mutations`, "POST", attempt.body, { "idempotency-key": attempt.key });
  return checkedRemoteMutation(result.operation, attempt.accountId, attempt.messageId, attempt);
}
export async function latestRemoteMutation(message: NormalMail, signal: AbortSignal) {
  const result = await api<{ operation: unknown }>(`${normalMessagePath(message)}/remote-mutations`, "GET", undefined, undefined, signal);
  return result.operation === null ? null : checkedRemoteMutation(result.operation, message.accountId, message.id, undefined, message.serverFolderId);
}
// Only these exact failures prove the POST was rejected before reservation. Unknown transport/storage/response failures keep the key.
export function remoteMutationRejectedBeforeReservation(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  const safe: Record<string, number> = {
    invalid_remote_mutation_request: 400, idempotency_key_required: 400, insufficient_scope: 403, origin_denied: 403, not_found: 404,
    remote_mutation_schema_required: 409, remote_mutation_target_changed: 409, remote_mutation_destination_sync_required: 409,
    normal_account_disabled: 409, imap_endpoint_changed: 409, normal_server_folder_not_current: 404, normal_server_folder_not_selectable: 409,
    remote_write_target_busy: 409, rate_limited: 429,
  };
  return safe[error.message] === error.status;
}
export async function mutationDestinationFolders(message: NormalMail, signal: AbortSignal) {
  const { account } = await api<{ account: NormalAccount }>(`/normal-accounts/${message.accountId}`, "GET", undefined, undefined, signal);
  if (!account || account.id !== message.accountId || account.revision !== message.accountRevision || account.enabled !== true || account.deleted !== false) {
    throw new ApiError(409, "remote_mutation_target_changed");
  }
  const catalog = await serverFolders(account, false, signal);
  if (!catalog.current) throw new ApiError(409, "remote_mutation_catalog_required");
  return catalog.items.filter(folder => folder.selectable && (message.serverFolderId ? folder.id !== message.serverFolderId : folder.wireName !== "INBOX"));
}
export async function mutationDestinationEpoch(message: NormalMail, folder: ServerFolder, signal: AbortSignal) {
  const path = normalInboxPath(message.accountId, folder.wireName === "INBOX" ? "" : folder.id);
  const row = await api<NormalMailPage>(`${path}/messages?limit=1`, "GET", undefined, undefined, signal);
  if (!row || row.accountRevision !== message.accountRevision || row.sourceReady !== true || typeof row.epochId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.epochId)) {
    throw new ApiError(409, "remote_mutation_destination_sync_required");
  }
  return row.epochId;
}
