import { unixNow, type Env } from "./contracts";
import { HttpError } from "./http";
import type { RemoteMessageTarget } from "./normal-remote-flags-target";
import type { ImapMutationPhase, ImapMutationResult } from "./normal-imap-mutations";

export interface RemoteMutationOperation extends RemoteMessageTarget {
  id: string; sequence: number; request_key: string; request_hash: string; action: "move" | "delete";
  destination_folder_id: string | null; destination_wire_name: string | null; destination_catalog_source: string | null;
  destination_source_hash: string | null; destination_epoch_id: string | null; destination_uid_validity: string | null;
  destination_cache_generation: number | null; destination_uid: number | null;
  state: "pending" | "confirmed" | "failed" | "unknown"; phase: ImapMutationPhase | null;
  method: ImapMutationResult["method"] | null; source_removed: number; error_code: string | null;
  created_at: number; dispatched_at: number | null; phase_at: number | null; finished_at: number | null;
}
export const remoteMutationByKey = (env: Env, userId: string, key: string) => env.DB.prepare(
  "SELECT * FROM normal_remote_mutation_operations WHERE user_id=? AND request_key=?").bind(userId, key).first<RemoteMutationOperation>();
export const latestRemoteMutation = (env: Env, userId: string, accountId: string, messageId: string) => env.DB.prepare(
  "SELECT * FROM normal_remote_mutation_operations WHERE user_id=? AND account_id=? AND message_id=? ORDER BY sequence DESC LIMIT 1")
  .bind(userId, accountId, messageId).first<RemoteMutationOperation>();
export function remoteMutationView(row: RemoteMutationOperation) {
  const stale = row.state === "pending" && row.created_at <= unixNow() - 60;
  return { id: row.id, accountId: row.account_id, messageId: row.message_id, accountRevision: row.account_revision,
    epochId: row.epoch_id, uid: row.uid, uidValidity: row.uid_validity, requestKey: row.request_key, action: row.action,
    state: stale ? "unknown" : row.state, phase: row.phase, method: row.method, sourceRemoved: !!row.source_removed,
    destinationFolderId: row.destination_folder_id, destinationEpochId: row.destination_epoch_id,
    destination: row.destination_uid === null ? null : { uidValidity: row.destination_uid_validity!, uid: row.destination_uid },
    error: stale ? "remote_mutation_outcome_unknown" : row.error_code, retrySafe: false, cacheRetained: true,
    createdAt: row.created_at, dispatchedAt: row.dispatched_at, phaseAt: row.phase_at, finishedAt: row.finished_at,
    ...(row.server_folder_id ? { serverFolderId: row.server_folder_id } : {}) };
}
export function assertRemoteMutationReplay(row: RemoteMutationOperation, hash: string) {
  if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
}
