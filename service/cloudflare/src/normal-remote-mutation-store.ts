import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import type { NormalInboxContext, NormalStoredMessage } from "./normal-inbox-access";
import { remoteFlagTargetFence } from "./normal-remote-flags-target";
import type { RemoteMutationInput } from "./normal-remote-mutation-input";
import { assertRemoteMutationReplay, remoteMutationByKey, type RemoteMutationOperation } from "./normal-remote-mutation-model";
import { mutationCredentialFence, mutationDestinationFence, type MutationDestination } from "./normal-remote-mutation-target";
import { flagsBlockMutation, mutationBlocksRemoteWrite } from "./normal-remote-write-barrier";
import type { ImapMutationPhase, ImapMutationResult } from "./normal-imap-mutations";
import type { ImapDestinationUid } from "./normal-imap-mutation-state";

async function assertMutationAvailable(env: Env, row: RemoteMutationOperation) {
  if (await flagsBlockMutation(env, row) || await mutationBlocksRemoteWrite(env, row)) throw new HttpError(409, "remote_write_target_busy");
}
export async function reserveRemoteMutation(env: Env, context: NormalInboxContext, message: NormalStoredMessage, sourceHash: string,
  destination: MutationDestination | null, key: string, hash: string, input: RemoteMutationInput, identity: Identity) {
  const row: RemoteMutationOperation = { id: crypto.randomUUID(), sequence: 0, user_id: identity.userId,
    account_id: context.account.id, message_id: message.id, account_revision: input.expectedRevision, source_hash: sourceHash,
    epoch_id: input.epochId, cache_generation: context.cacheGeneration, uid_validity: message.uid_validity, uid: message.uid,
    server_folder_id: context.serverFolder?.id ?? null, server_wire_name: context.serverFolder?.wireName ?? null,
    catalog_source: context.serverFolder?.catalogSource ?? null, request_key: key, request_hash: hash, action: input.action,
    destination_folder_id: null, destination_wire_name: null, destination_catalog_source: null, destination_source_hash: null,
    destination_epoch_id: null, destination_uid_validity: null, destination_cache_generation: null, destination_uid: null,
    ...destination, state: "pending", phase: null, method: null, source_removed: 0, error_code: null,
    created_at: unixNow(), dispatched_at: null, phase_at: null, finished_at: null };
  await assertMutationAvailable(env, row);
  const target = await remoteFlagTargetFence(env, row), to = mutationDestinationFence(row), caller = mutationCredentialFence(identity, input.action);
  const columns = ["id", "user_id", "account_id", "message_id", "account_revision", "source_hash", "epoch_id", "cache_generation", "uid_validity", "uid",
    "server_folder_id", "server_wire_name", "catalog_source", "request_key", "request_hash", "action", "destination_folder_id", "destination_wire_name",
    "destination_catalog_source", "destination_source_hash", "destination_epoch_id", "destination_uid_validity", "destination_cache_generation"] as const;
  let changed: boolean;
  try {
    const result = await env.DB.prepare(`INSERT INTO normal_remote_mutation_operations (${columns.join(",")},state,created_at)
      SELECT ${columns.map(() => "?").join(",")},'pending',unixepoch() WHERE ${target.sql} AND ${to.sql} AND ${caller.sql}
      AND (SELECT COUNT(*) FROM normal_remote_mutation_operations WHERE user_id=?)<10000`)
      .bind(...columns.map(column => row[column] ?? null), ...target.values, ...to.values, ...caller.values, row.user_id).run();
    changed = !!result.meta.changes;
  } catch {
    // A reconciled INSERT is only a receipt. Lost write acknowledgement never grants execution authority.
    const actual = await remoteMutationByKey(env, row.user_id, key);
    if (actual) { assertRemoteMutationReplay(actual, hash); return { row: actual, execute: false }; }
    await assertMutationAvailable(env, row); throw new HttpError(503, "remote_mutation_storage_unknown");
  }
  const actual = await remoteMutationByKey(env, row.user_id, key);
  if (!actual) throw new HttpError(409, "remote_mutation_changed_or_limit");
  assertRemoteMutationReplay(actual, hash); return { row: actual, execute: changed && actual.id === row.id };
}
export async function recordRemoteMutationDestination(env: Env, row: RemoteMutationOperation, destination: ImapDestinationUid) {
  if (row.action !== "move" || destination.uidValidity !== row.destination_uid_validity) throw new HttpError(409, "remote_mutation_target_changed");
  // An observed COPYUID remains a historical fact even if a timeout or a changed catalog stops all further commands.
  const result = await env.DB.prepare(`UPDATE normal_remote_mutation_operations SET destination_uid=?
    WHERE id=? AND state IN ('pending','unknown') AND dispatched_at IS NOT NULL
    AND (destination_uid IS NULL OR destination_uid=?)`).bind(destination.uid, row.id, destination.uid).run();
  if (!result.meta.changes) throw new HttpError(409, "remote_mutation_target_changed");
}
export async function dispatchRemoteMutation(env: Env, row: RemoteMutationOperation, identity: Identity,
  authentication: { sql: string; values: (string | number)[] }, phase: ImapMutationPhase, destination?: ImapDestinationUid, validity?: string) {
  const first = row.phase === null;
  const validPhase = first ? row.action === "delete" ? phase === "mark-deleted" : phase === "move" || phase === "copy"
    : row.phase === "copy" ? phase === "mark-deleted" : row.phase === "mark-deleted" && phase === "expunge";
  if (!validPhase || (row.action === "move" && (validity !== row.destination_uid_validity
    || (!first && (!destination || destination.uidValidity !== validity))))) throw new HttpError(409, "remote_mutation_target_changed");
  const target = await remoteFlagTargetFence(env, row), to = mutationDestinationFence(row), caller = mutationCredentialFence(identity, row.action);
  const method = row.action === "delete" ? "delete" : phase === "move" ? "move" : "copy-expunge";
  const result = await env.DB.prepare(`UPDATE normal_remote_mutation_operations SET dispatched_at=COALESCE(dispatched_at,unixepoch()),
    phase=?,phase_at=unixepoch(),method=?,destination_uid=COALESCE(?,destination_uid)
    WHERE id=? AND state='pending' AND phase IS ? AND created_at>unixepoch()-30 AND ${target.sql} AND ${to.sql} AND ${caller.sql} AND ${authentication.sql}`)
    .bind(phase, method, destination?.uid ?? null, row.id, row.phase, ...target.values, ...to.values, ...caller.values, ...authentication.values).run();
  if (!result.meta.changes) throw new HttpError(409, "remote_mutation_target_changed");
  row.phase = phase;
}
export async function finishRemoteMutation(env: Env, row: RemoteMutationOperation, result: ImapMutationResult | null, error: string | null) {
  try {
    await env.DB.prepare(`UPDATE normal_remote_mutation_operations
      SET state=CASE WHEN ?=1 THEN 'confirmed' WHEN dispatched_at IS NULL THEN 'failed' ELSE 'unknown' END,
      destination_uid=COALESCE(?,destination_uid),source_removed=?,error_code=?,finished_at=unixepoch()
      WHERE id=? AND state='pending'`)
      .bind(result ? 1 : 0, result?.destination?.uid ?? null, result ? 1 : 0, error, row.id).run();
  } catch {
    const actual = await remoteMutationByKey(env, row.user_id, row.request_key);
    if (!actual || actual.state === "pending") throw new HttpError(503, "remote_mutation_storage_unknown");
  }
  const actual = await remoteMutationByKey(env, row.user_id, row.request_key);
  if (!actual) throw new HttpError(503, "remote_mutation_storage_unknown");
  return actual;
}
