import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { identityCredentialFence } from "./identity";
import type { NormalInboxContext, NormalStoredMessage } from "./normal-inbox-access";
import type { RemoteFlagInput } from "./normal-remote-flags-input";
import { remoteFlagFolderSchema, remoteFlagTargetFence } from "./normal-remote-flags-target";
import { mutationBlocksRemoteWrite } from "./normal-remote-write-barrier";

export interface RemoteFlagOperation {
  id: string; sequence: number; user_id: string; account_id: string; message_id: string; account_revision: number;
  source_hash: string; epoch_id: string; cache_generation: number; uid_validity: string; uid: number;
  request_key: string; request_hash: string; flag: RemoteFlagInput["flag"]; value: number; acknowledged_unknown_id: string | null;
  state: "pending" | "confirmed" | "failed" | "unknown"; remote_flags: string | null; error_code: string | null;
  created_at: number; dispatched_at: number | null; finished_at: number | null;
  server_folder_id?: string | null; server_wire_name?: string | null; catalog_source?: string | null;
}
export const remoteFlagByKey = (env: Env, userId: string, key: string) => env.DB.prepare(
  "SELECT * FROM normal_remote_flag_operations WHERE user_id=? AND request_key=?").bind(userId, key).first<RemoteFlagOperation>();
export const latestRemoteFlag = (env: Env, userId: string, accountId: string, messageId: string) => env.DB.prepare(
  "SELECT * FROM normal_remote_flag_operations WHERE user_id=? AND account_id=? AND message_id=? ORDER BY sequence DESC LIMIT 1")
  .bind(userId, accountId, messageId).first<RemoteFlagOperation>();
export function remoteFlagView(row: RemoteFlagOperation) {
  const stale = row.state === "pending" && row.created_at <= unixNow() - 60;
  return { id: row.id, accountId: row.account_id, messageId: row.message_id, accountRevision: row.account_revision, epochId: row.epoch_id,
    uid: row.uid, flag: row.flag, value: !!row.value, acknowledgedUnknownId: row.acknowledged_unknown_id, requestKey: row.request_key,
    state: stale ? "unknown" : row.state, remoteFlags: row.remote_flags === null ? null : JSON.parse(row.remote_flags) as string[],
    error: stale ? "remote_flags_outcome_unknown" : row.error_code, retrySafe: false,
    createdAt: row.created_at, dispatchedAt: row.dispatched_at, finishedAt: row.finished_at,
    ...(row.server_folder_id ? { serverFolderId: row.server_folder_id } : {}) };
}
export function assertRemoteFlagReplay(row: RemoteFlagOperation, hash: string) {
  if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
}
export async function reserveRemoteFlag(env: Env, context: NormalInboxContext, message: NormalStoredMessage, sourceHash: string,
  key: string, hash: string, input: RemoteFlagInput, identity: Identity) {
  const folderSchema = await remoteFlagFolderSchema(env);
  if (context.serverFolder && !folderSchema) throw new HttpError(409, "remote_flags_folder_schema_required");
  const previous = await latestRemoteFlag(env, context.account.user_id, context.account.id, message.id);
  const state = previous && remoteFlagView(previous).state;
  if (state === "pending" || (state === "unknown" ? input.acknowledgedUnknownId !== previous!.id : input.acknowledgedUnknownId !== null)) {
    throw new HttpError(409, "remote_flags_previous_unresolved");
  }
  const row: RemoteFlagOperation = { id: crypto.randomUUID(), sequence: 0, user_id: context.account.user_id,
    account_id: context.account.id, message_id: message.id, account_revision: input.expectedRevision, source_hash: sourceHash,
    epoch_id: input.epochId, cache_generation: context.cacheGeneration, uid_validity: message.uid_validity, uid: message.uid,
    request_key: key, request_hash: hash, flag: input.flag, value: Number(input.value), acknowledged_unknown_id: input.acknowledgedUnknownId,
    state: "pending", remote_flags: null, error_code: null, created_at: unixNow(), dispatched_at: null, finished_at: null,
    server_folder_id: context.serverFolder?.id ?? null, server_wire_name: context.serverFolder?.wireName ?? null,
    catalog_source: context.serverFolder?.catalogSource ?? null };
  if (await mutationBlocksRemoteWrite(env, row)) throw new HttpError(409, "remote_write_target_busy");
  const target = await remoteFlagTargetFence(env, row);
  let changed;
  try {
    const result = await env.DB.prepare(`INSERT INTO normal_remote_flag_operations
      (id,user_id,account_id,message_id,account_revision,source_hash,epoch_id,cache_generation,uid_validity,uid,request_key,request_hash,flag,value,acknowledged_unknown_id,state,created_at${folderSchema ? ",server_folder_id,server_wire_name,catalog_source" : ""})
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',unixepoch()${folderSchema ? ",?,?,?" : ""} WHERE ${target.sql} AND ${identityCredentialFence(identity)}
      AND COALESCE((SELECT id FROM normal_remote_flag_operations WHERE message_id=? ORDER BY sequence DESC LIMIT 1),'')=?
      AND (SELECT COUNT(*) FROM normal_remote_flag_operations WHERE user_id=?)<10000`)
      .bind(row.id, row.user_id, row.account_id, row.message_id, row.account_revision, row.source_hash, row.epoch_id,
        row.cache_generation, row.uid_validity, row.uid, key, hash, row.flag, row.value, row.acknowledged_unknown_id,
        ...(folderSchema ? [row.server_folder_id, row.server_wire_name, row.catalog_source] : []),
        ...target.values, identity.credentialId, identity.userId, row.message_id, previous?.id ?? "", row.user_id).run();
    changed = !!result.meta.changes;
  } catch {
    // An ambiguous INSERT may already exist. A reconciled reservation is never authority to execute it again.
    const actual = await remoteFlagByKey(env, row.user_id, key);
    if (!actual) {
      if (await mutationBlocksRemoteWrite(env, row)) throw new HttpError(409, "remote_write_target_busy");
      throw new HttpError(503, "remote_flags_storage_unknown");
    }
    assertRemoteFlagReplay(actual, hash); return { row: actual, execute: false };
  }
  const actual = await remoteFlagByKey(env, row.user_id, key);
  if (!actual) throw new HttpError(409, "remote_flags_changed_or_limit");
  assertRemoteFlagReplay(actual, hash); return { row: actual, execute: changed && actual.id === row.id };
}
export async function dispatchRemoteFlag(env: Env, row: RemoteFlagOperation, identity: Identity, authentication: { sql: string; values: (string | number)[] }) {
  const target = await remoteFlagTargetFence(env, row);
  const result = await env.DB.prepare(`UPDATE normal_remote_flag_operations SET dispatched_at=unixepoch()
    WHERE id=? AND state='pending' AND dispatched_at IS NULL AND created_at>unixepoch()-30 AND ${target.sql}
    AND ${identityCredentialFence(identity)} AND ${authentication.sql}
    AND NOT EXISTS (SELECT 1 FROM normal_remote_flag_operations newer WHERE newer.message_id=? AND newer.sequence>?)`)
    .bind(row.id, ...target.values, identity.credentialId, identity.userId, ...authentication.values, row.message_id, row.sequence).run();
  if (!result.meta.changes) throw new HttpError(409, "remote_flags_target_changed");
}
export async function finishRemoteFlag(env: Env, row: RemoteFlagOperation, flags: string[] | null, error: string | null) {
  const target = await remoteFlagTargetFence(env, row);
  const state = flags ? "confirmed" : null;
  const statements = [env.DB.prepare(`UPDATE normal_remote_flag_operations SET state=COALESCE(?,CASE WHEN dispatched_at IS NULL THEN 'failed' ELSE 'unknown' END),
    remote_flags=?,error_code=?,finished_at=unixepoch() WHERE id=? AND state='pending'`)
    .bind(state, flags ? JSON.stringify(flags) : null, error, row.id)];
  if (flags) statements.push(env.DB.prepare(`UPDATE normal_inbox_messages SET flags=? WHERE id=? AND ${target.sql}
    AND EXISTS (SELECT 1 FROM normal_remote_flag_operations WHERE id=? AND state='confirmed')
    AND NOT EXISTS (SELECT 1 FROM normal_remote_flag_operations newer WHERE newer.message_id=? AND newer.sequence>?)`)
    .bind(JSON.stringify(flags), row.message_id, ...target.values, row.id, row.message_id, row.sequence));
  try { await env.DB.batch(statements); }
  catch {
    const actual = await remoteFlagByKey(env, row.user_id, row.request_key);
    if (!actual || actual.state === "pending") throw new HttpError(503, "remote_flags_storage_unknown");
  }
  const actual = await remoteFlagByKey(env, row.user_id, row.request_key);
  if (!actual) throw new HttpError(503, "remote_flags_storage_unknown");
  return actual;
}
