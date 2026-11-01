import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { executeSend } from "./send-message";
import type { SendInput } from "./send-input";
import { jobOutgoing, JOB_ACTIVE, sourceForJob, type SendJob } from "./send-job-model";
import { JOB_SOURCES, activeJobUser, noJobOutgoing, type JobSource } from "./send-job-source";
import { executeNormalSend } from "./normal-send";
import type { NormalSendInput } from "./normal-send-input";

const BACKOFF = [60, 300, 900, 3600];
async function reconcileJobs(env: Env, source: JobSource) {
  const noOutgoing = noJobOutgoing(source), active = activeJobUser(source), usable = source.usable, table = source.table;
  // A reservation acknowledgement can be lost after commit. Reconcile evidence; never probe by sending again.
  await env.DB.prepare(`UPDATE ${table} SET state='submitted',revision=revision+1,claim_token=NULL,lease_until=NULL,updated_at=unixepoch(),
    outgoing_id=(SELECT id FROM ${source.outgoing} o WHERE o.user_id=${table}.user_id AND o.request_key=${table}.outgoing_key)
    WHERE id IN (SELECT id FROM ${table} WHERE ${JOB_ACTIVE} AND NOT (${noOutgoing}) LIMIT 20)`).run();
  await env.DB.prepare(`UPDATE ${table} SET state='failed',revision=revision+1,claim_token=NULL,lease_until=NULL,updated_at=unixepoch(),
    error_code=CASE WHEN deadline_at<=unixepoch() THEN 'send_job_expired' WHEN NOT (${active}) THEN 'account_inactive'
      WHEN NOT (${usable}) THEN '${source.unavailable}' ELSE 'send_job_preparation_exhausted' END
    WHERE id IN (SELECT id FROM ${table} WHERE ${JOB_ACTIVE} AND ${noOutgoing} AND
      (deadline_at<=unixepoch() OR NOT (${active}) OR NOT (${usable}) OR
        (attempts>=5 AND (state='queued' OR lease_until<=unixepoch()))) LIMIT 20)`).run();
}

async function claimJob(env: Env, id: string, source: JobSource): Promise<SendJob | null> {
  const token = crypto.randomUUID();
  await env.DB.prepare(`UPDATE ${source.table} SET state='preparing',claim_token=?,lease_until=unixepoch()+120,
    attempts=attempts+1,revision=revision+1,updated_at=unixepoch() WHERE id=? AND deadline_at>unixepoch() AND attempts<5
    AND ((state='queued' AND next_attempt_at<=unixepoch()) OR (state='preparing' AND lease_until<=unixepoch()))
    AND ${noJobOutgoing(source)} AND ${activeJobUser(source)} AND ${source.usable}`).bind(token, id).run();
  return env.DB.prepare(`SELECT * FROM ${source.table} WHERE id=? AND claim_token=? AND state='preparing'`).bind(id, token).first<SendJob>();
}

async function preparationFailed(env: Env, row: SendJob, error: unknown) {
  const source = sourceForJob(row);
  if (await jobOutgoing(env, row)) return;
  const transient = !(error instanceof HttpError) || error.status >= 500 || error.status === 429
    || ["provider_config_changed", "send_job_reservation_denied"].includes(error.code);
  const next = unixNow() + (BACKOFF[Math.min(row.attempts - 1, BACKOFF.length - 1)] ?? 3600);
  const retry = transient && row.attempts < 5 && next < row.deadline_at;
  await env.DB.prepare(`UPDATE ${source.table} SET state=?,next_attempt_at=?,error_code=?,claim_token=NULL,lease_until=NULL,
    revision=revision+1,updated_at=unixepoch() WHERE id=? AND state='preparing' AND claim_token=? AND ${noJobOutgoing(source)}`)
    .bind(retry ? "queued" : "failed", next, error instanceof HttpError ? error.code : "send_job_preparation_failed", row.id, row.claim_token).run();
}

export async function runSendJobs(env: Env): Promise<void> {
  for (const source of JOB_SOURCES) await reconcileJobs(env, source);
  const { results } = await env.DB.prepare(`${JOB_SOURCES.map(source => `SELECT id,next_attempt_at,'${source.kind}' AS kind FROM ${source.table} WHERE deadline_at>unixepoch() AND attempts<5
    AND ((state='queued' AND next_attempt_at<=unixepoch()) OR (state='preparing' AND lease_until<=unixepoch()))
    `).join(" UNION ALL ")} ORDER BY next_attempt_at,id,kind LIMIT 3`).all<{ id: string; kind: string }>();
  for (const candidate of results) {
    const source = JOB_SOURCES.find(item => item.kind === candidate.kind)!;
    const row = await claimJob(env, candidate.id, source); if (!row) continue;
    const identity: Identity = { userId: row.user_id, username: "", kind: "session", credentialId: "durable-intent", scopes: [] };
    try {
      if (!row.payload_json || !row.claim_token) throw new HttpError(409, "send_job_content_unavailable");
      const claim = { id: row.id, user_id: row.user_id, claim_token: row.claim_token };
      if (row.account_id === undefined) await executeSend(env, identity, row.mailbox_id, JSON.parse(row.payload_json) as SendInput, claim);
      else await executeNormalSend(env, identity, row.account_id, { ...JSON.parse(row.payload_json) as NormalSendInput,
        key: row.outgoing_key, accountRevision: row.account_revision, smtpRevision: row.smtp_revision }, { ...claim, source: "normal" });
    } catch (error) { await preparationFailed(env, row, error); }
  }
  for (const source of JOB_SOURCES) await reconcileJobs(env, source);
}
