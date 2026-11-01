import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { normalSendHashes, normalSendInput } from "./normal-send-input";
import { prepareNormalSend } from "./normal-send-preparation";
import { assertDraftSend, draftSendFence } from "./draft-send";
import { outboxFence } from "./outbox-references";
import { resolveAssets } from "./outbox-store";
import { outboxStorage, OUTBOX_MESSAGE_BYTES } from "./outbox-model";
import { jobByKey, jobView, type SendJob } from "./send-job-model";
import { NORMAL_JOBS } from "./send-job-source";
import { tokenHash } from "./security";

export async function enqueueNormalSendJob(request: Request, env: Env, identity: Identity, accountId: string) {
  requireWriteScope(request, env, identity, "mail-accounts:schedule"); requireScope(identity, "mail-accounts:send");
  const { scheduledAt = null, ...body } = await readJson(request);
  if (scheduledAt !== null && (!Number.isSafeInteger(scheduledAt) || (scheduledAt as number) < 0)) throw new HttpError(400, "invalid_scheduled_time");
  const input = normalSendInput(body, request.headers.get("idempotency-key") ?? "");
  if (input.attachments.length) requireScope(identity, "attachments:read");
  if (input.draft) requireScope(identity, "drafts:write");
  if (input.reply) { requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read"); }
  const { hash, contentHash } = await normalSendHashes(accountId, input);
  const requestHash = await tokenHash(JSON.stringify(["normal-send-job-v1", hash, scheduledAt]));
  const replay = async (row: SendJob, created = false) => {
    if (row.request_hash !== requestHash) throw new HttpError(409, "idempotency_conflict");
    return json({ job: await jobView(env, row) }, created ? 201 : 200);
  };
  const previous = await jobByKey(env, identity, input.key, NORMAL_JOBS); if (previous) return replay(previous);
  const now = unixNow(), due = scheduledAt === null ? now : scheduledAt as number;
  if (due < now || due > now + 30 * 86400) throw new HttpError(400, "invalid_scheduled_time");
  await assertDraftSend(env, identity, input.draft, contentHash, accountId);
  const { endpoint, replyFence } = await prepareNormalSend(env, identity, accountId, input);
  if (input.attachments.length) outboxStorage(env);
  const { assets, manifests } = await resolveAssets(env, identity, input.attachments);
  if (assets.reduce((total, row) => total + row.size, 0) > OUTBOX_MESSAGE_BYTES) throw new HttpError(413, "outbox_message_too_large");
  const deadline = Math.min(due + 86400, ...assets.map(row => row.expires_at));
  if (deadline <= due) throw new HttpError(409, "attachment_expires_before_schedule");
  const draft = draftSendFence(identity, input.draft, contentHash, accountId), files = outboxFence(identity.userId, input.attachments);
  const id = crypto.randomUUID(), outgoingKey = `queue:${id}`;
  const statement = env.DB.prepare(`INSERT INTO normal_send_jobs
    (id,user_id,account_id,account_revision,smtp_revision,request_key,request_hash,outgoing_key,payload_json,attachments_json,draft_id,draft_revision,
      scheduled_at,due_at,deadline_at,next_attempt_at,state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,? WHERE
      EXISTS (SELECT 1 FROM users WHERE id=? AND status='active') AND
      EXISTS (SELECT 1 FROM normal_accounts WHERE user_id=? AND id=? AND revision=? AND enabled=1 AND deleted_at IS NULL) AND
      EXISTS (SELECT 1 FROM normal_smtp_configs WHERE user_id=? AND account_id=? AND revision=? AND account_revision=? AND enabled=1 AND credential_cipher IS NOT NULL AND endpoint_hash=?) AND
      ${draft.sql} AND ${files.sql} AND ${replyFence.sql} AND
      (SELECT COUNT(*) FROM send_job_usage WHERE user_id=? AND state IN ('queued','preparing'))<20 AND
      (SELECT COUNT(*) FROM send_job_usage WHERE state IN ('queued','preparing'))<200 AND
      (SELECT COUNT(*) FROM send_job_usage WHERE user_id=? AND created_at>=?)<20 AND
      (SELECT COUNT(*) FROM send_job_usage WHERE created_at>=?)<200
    ON CONFLICT DO NOTHING`).bind(id, identity.userId, accountId, input.accountRevision, input.smtpRevision, input.key, requestHash, outgoingKey,
      JSON.stringify({ ...input, key: outgoingKey }), manifests.length ? JSON.stringify(manifests) : null,
      input.draft?.id ?? null, input.draft?.revision ?? null, scheduledAt, due, deadline, due, now, now,
      identity.userId, identity.userId, accountId, input.accountRevision, identity.userId, accountId, input.smtpRevision, input.accountRevision, endpoint.hash,
      ...draft.values, ...files.values, ...replyFence.values, identity.userId, identity.userId, Math.floor(now / 86400) * 86400, Math.floor(now / 86400) * 86400);
  const writes = input.draft ? await env.DB.batch([statement,
    env.DB.prepare(`UPDATE drafts SET state='submitted',revision=revision+1,updated_at=unixepoch()
      WHERE user_id=? AND id=? AND revision=? AND state='editing' AND normal_account_id=?
        AND EXISTS (SELECT 1 FROM normal_send_jobs WHERE id=? AND user_id=?)`)
      .bind(identity.userId, input.draft.id, input.draft.revision, accountId, id, identity.userId),
  ]) : [await statement.run()];
  if (writes[0].meta.changes && input.draft && writes[1].meta.changes !== 1) throw new HttpError(503, "send_job_storage_failed");
  const row = await jobByKey(env, identity, input.key, NORMAL_JOBS);
  if (row) return replay(row, !!writes[0].meta.changes);
  await assertDraftSend(env, identity, input.draft, contentHash, accountId);
  await resolveAssets(env, identity, input.attachments);
  throw new HttpError(429, "send_job_quota_or_eligibility_changed");
}
