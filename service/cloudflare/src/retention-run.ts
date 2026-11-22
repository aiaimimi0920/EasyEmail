import { unixNow, type Env } from "./contracts";
import { ADMIN_EXISTS } from "./admin-access";
import { HttpError } from "./http";
import { MESSAGE_CONTENT_RESET } from "./message-tombstone";
import { readRetention, RETENTION_BATCH_LIMIT, RETENTION_POLICY_FENCE } from "./retention-policy";
import { retentionRunByKey, retentionRunView } from "./retention-store";
import { retentionTargets } from "./retention-targets";
import { tokenHash } from "./security";
import { sendJobRedaction } from "./send-job-retention";
import { JOB_SOURCES } from "./send-job-source";
import { normalRetentionStatements } from "./normal-retention-store";
import { maintainNormalInbox } from "./normal-inbox-cleanup";

export async function runRetention(env: Env, input: { key: string; revision: number; actorId: string | null; trigger: "manual" | "scheduled" }) {
  const requestHash = await tokenHash(JSON.stringify([input.revision]));
  const replay = (row: NonNullable<Awaited<ReturnType<typeof retentionRunByKey>>>) => {
    if (row.request_hash !== requestHash) throw new HttpError(409, "idempotency_conflict");
    return { run: retentionRunView(row), replayed: true };
  };
  const previous = await retentionRunByKey(env, input.key);
  if (previous) return replay(previous);
  const state = await readRetention(env);
  if (state.revision !== input.revision) throw new HttpError(409, "retention_policy_changed");
  const now = unixNow(), id = crypto.randomUUID(), hash = await tokenHash(JSON.stringify(state.policy));
  const guard = "EXISTS (SELECT 1 FROM retention_runs WHERE id = ? AND completed_at IS NULL)";
  const statements = [env.DB.prepare(`INSERT INTO retention_runs
    (id,run_key,request_hash,config_revision,policy_hash,actor_id,trigger_kind,started_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${RETENTION_POLICY_FENCE} ${input.actorId ? `AND ${ADMIN_EXISTS}` : ""}
    ON CONFLICT(run_key) DO NOTHING`).bind(id, input.key, requestHash, state.revision, hash, input.actorId,
      input.trigger, now, state.revision, ...(input.actorId ? [input.actorId] : []))];
  for (const target of retentionTargets(state.policy, now, MESSAGE_CONTENT_RESET)) {
    const selected = `SELECT id FROM ${target.table} WHERE ${target.where} ORDER BY ${target.order} LIMIT ${RETENTION_BATCH_LIMIT}`;
    if (target.table === "messages") for (const table of ["message_thread_links", "message_subscriptions"]) statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE message_id IN (${selected}) AND ${guard}`)
      .bind(...target.values, id));
    statements.push(env.DB.prepare(`${target.assignments ? `UPDATE ${target.table} SET ${target.assignments}` : `DELETE FROM ${target.table}`}
      WHERE id IN (${selected}) AND ${guard}`).bind(...(target.assignments ? [now] : []), ...target.values, id));
    statements.push(env.DB.prepare(`UPDATE retention_runs SET ${target.countColumn} = changes() WHERE id = ? AND completed_at IS NULL`).bind(id));
  }
  statements.push(...await normalRetentionStatements(env, state.policy, now, id));
  for (const source of JOB_SOURCES) { const jobs = sendJobRedaction(env, state.policy, now, id, source); if (jobs) statements.push(jobs); }
  statements.push(env.DB.prepare("UPDATE retention_runs SET completed_at = ? WHERE id = ? AND completed_at IS NULL").bind(now, id));
  let writes: D1Result[];
  try { writes = await env.DB.batch(statements); }
  catch { throw new HttpError(503, "retention_storage_failed"); }
  const row = await retentionRunByKey(env, input.key);
  if (!row) throw new HttpError(409, "retention_policy_changed");
  if (writes[0].meta.changes && input.trigger === "manual") await maintainNormalInbox(env);
  return writes[0].meta.changes ? { run: retentionRunView(row), replayed: false } : replay(row);
}

export async function scheduledRetention(env: Env, scheduledTime: number): Promise<void> {
  const state = await readRetention(env), bucket = Math.floor(scheduledTime / 900000);
  await runRetention(env, { key: await tokenHash(`retention:scheduled:${bucket}:${state.revision}`), revision: state.revision,
    actorId: null, trigger: "scheduled" });
}
