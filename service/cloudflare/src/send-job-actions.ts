import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireWriteScope } from "./identity";
import { tokenHash } from "./security";
import { jobView, ownedJob } from "./send-job-model";
import { TEMPORARY_JOBS, noJobOutgoing, type JobSource } from "./send-job-source";

interface Operation { request_hash: string }
export async function sendJobAction(request: Request, env: Env, identity: Identity, id: string, kind: "cancel" | "retry", source: JobSource = TEMPORARY_JOBS, accountId?: string) {
  requireWriteScope(request, env, identity, source.scheduleScope);
  if (kind === "retry") requireWriteScope(request, env, identity, source.sendScope);
  await ownedJob(env, identity, id, source, accountId);
  const body = await readJson(request), key = request.headers.get("idempotency-key") ?? "";
  if (Object.keys(body).some(k => k !== "expectedRevision") || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) throw new HttpError(400, "invalid_job_revision");
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  const hash = await tokenHash(JSON.stringify([id, kind, body.expectedRevision]));
  const previous = () => env.DB.prepare(`SELECT request_hash FROM ${source.operations} WHERE user_id=? AND request_key=?`)
    .bind(identity.userId, key).first<Operation>();
  const replay = async (row: Operation) => {
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
    return json({ job: await jobView(env, await ownedJob(env, identity, id, source, accountId)) });
  };
  const existing = await previous(); if (existing) return replay(existing);
  const opId = crypto.randomUUID(), now = unixNow();
  const eligible = kind === "cancel" ? "state IN ('queued','preparing')"
    : "state='failed' AND payload_json IS NOT NULL AND deadline_at>unixepoch() AND attempts<5 AND manual_retries<3";
  const writes = await env.DB.batch([
    env.DB.prepare(`INSERT INTO ${source.operations}(id,user_id,job_id,request_key,request_hash,kind,applied_revision,created_at)
      SELECT ?,?,?,?,?,?,revision+1,? FROM ${source.table} WHERE id=? AND user_id=? AND revision=? AND ${eligible} AND ${noJobOutgoing(source)}
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active') ON CONFLICT(user_id,request_key) DO NOTHING`)
      .bind(opId, identity.userId, id, key, hash, kind, now, id, identity.userId, body.expectedRevision, identity.userId),
    env.DB.prepare(`UPDATE ${source.table} SET state=?,revision=revision+1,claim_token=NULL,lease_until=NULL,updated_at=?,error_code=?,
      next_attempt_at=?,manual_retries=manual_retries+? WHERE id=? AND user_id=? AND revision=?
      AND EXISTS (SELECT 1 FROM ${source.operations} WHERE id=? AND job_id=${source.table}.id AND applied_revision=${source.table}.revision+1)`)
      .bind(kind === "cancel" ? "cancelled" : "queued", now, kind === "cancel" ? "send_job_cancelled" : null,
        now, kind === "retry" ? 1 : 0, id, identity.userId, body.expectedRevision, opId),
  ]);
  if (writes[0].meta.changes && writes[1].meta.changes !== 1) throw new HttpError(503, "send_job_storage_failed");
  const operation = await previous(); if (operation) return replay(operation);
  throw new HttpError(409, "send_job_changed_or_not_actionable");
}
