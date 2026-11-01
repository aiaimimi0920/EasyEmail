import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, readJson } from "./http";
import { recipientsJson, toList } from "./outgoing-recipients";
import { sendSmtp } from "./smtp-client";
import { smtpMime } from "./smtp-mime";
import { sendQuotaFence } from "./send-quota-fence";
import { normalOutgoingByKey, replayNormalOutgoing, type NormalOutgoing } from "./normal-outgoing-store";
import { assertDraftSend, draftSendFence, reserveDraftSend } from "./draft-send";
import { requireScope, requireWriteScope } from "./identity";
import { outgoingAssets } from "./outbox-sending";
import { outboxFence } from "./outbox-references";
import { resolveAssets } from "./outbox-store";
import { normalSendHashes, normalSendInput, type NormalSendInput } from "./normal-send-input";
import { prepareNormalSend } from "./normal-send-preparation";
import { jobSendFence, reserveJobSend, type JobClaim } from "./send-job-reservation";

export async function sendNormalMessage(request: Request, env: Env, identity: Identity, accountId: string) {
  const input = normalSendInput(await readJson(request), request.headers.get("idempotency-key") ?? "");
  if (input.draft) requireWriteScope(request, env, identity, "drafts:write");
  if (input.attachments.length) requireScope(identity, "attachments:read");
  if (input.reply) { requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read"); }
  return executeNormalSend(env, identity, accountId, input);
}

// Claims are internal state-machine capabilities, never parsed from HTTP input.
export async function executeNormalSend(env: Env, identity: Identity, accountId: string, input: NormalSendInput, claim?: JobClaim) {
  const { accountRevision, smtpRevision: revision } = input, { hash, contentHash } = await normalSendHashes(accountId, input);
  const previous = await normalOutgoingByKey(env, identity.userId, input.key); if (previous) return replayNormalOutgoing(previous, hash);
  if (!claim) await assertDraftSend(env, identity, input.draft, contentHash, accountId);
  const { account, config, endpoint, recipients, credential, reply, replyFence } = await prepareNormalSend(env, identity, accountId, input, claim), count = recipients.length;
  const assets = await outgoingAssets(env, identity, input.attachments), assetFence = outboxFence(identity.userId, input.attachments);
  const id = crypto.randomUUID(), now = unixNow(), quota = sendQuotaFence(identity.userId, now, count);
  // Finish all byte validation and MIME construction before consuming quota, draft or no-repeat guard.
  const mime = smtpMime({ ...input, from: account.email_address, id, createdAt: now, attachments: assets.attachments, ...(reply ? { threading: reply } : {}) });
  const draftFence = draftSendFence(identity, claim ? null : input.draft, contentHash, accountId), jobFence = jobSendFence(claim);
  const row: NormalOutgoing = { id, user_id: identity.userId, account_id: accountId, account_revision: accountRevision, smtp_revision: revision,
    endpoint_hash: endpoint.hash, request_key: input.key, request_hash: hash, from_address: account.email_address, to_address: toList(input)[0],
    recipients_json: recipientsJson(input), recipient_count: count, subject: input.subject, text_body: input.text,
    state: "pending", error_code: null, created_at: now, updated_at: now, content_purged_at: null,
    reply_message_id: input.reply, reply_threading: reply ? reply.inReplyTo ? "submitted" : "unavailable" : null,
    attachments_json: assets.manifests.length ? JSON.stringify(assets.manifests) : null };
  let reserved;
  try { const statement = env.DB.prepare(`INSERT INTO normal_outgoing_messages
    (id,user_id,account_id,account_revision,smtp_revision,endpoint_hash,request_key,request_hash,from_address,to_address,recipients_json,recipient_count,subject,text_body,state,created_at,updated_at,reply_message_id,reply_threading,attachments_json)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,? WHERE
      EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
      AND EXISTS (SELECT 1 FROM normal_accounts WHERE user_id=? AND id=? AND revision=? AND enabled=1 AND deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM normal_smtp_configs WHERE user_id=? AND account_id=? AND revision=? AND account_revision=? AND enabled=1 AND credential_cipher IS NOT NULL AND endpoint_hash=?)
      AND (SELECT COUNT(*) FROM normal_outgoing_messages WHERE user_id=?)<10000 AND ${quota.sql} AND ${draftFence.sql} AND ${replyFence.sql} AND ${assetFence.sql} AND ${jobFence.sql} AND ${credential.fence.sql}
    ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(id, identity.userId, accountId, accountRevision, revision, endpoint.hash, input.key, hash, account.email_address, row.to_address, row.recipients_json, count, input.subject, input.text, now, now, row.reply_message_id, row.reply_threading, row.attachments_json,
      identity.userId, identity.userId, accountId, accountRevision, identity.userId, accountId, revision, accountRevision, endpoint.hash, identity.userId, ...quota.values, ...draftFence.values, ...replyFence.values, ...assetFence.values, ...jobFence.values, ...credential.fence.values);
    reserved = claim ? await reserveJobSend(env, claim, id, statement) : await reserveDraftSend(env, identity, input.draft, id, statement, accountId); }
  catch { throw new HttpError(503, "normal_send_storage_failed"); }
  if (!reserved.meta.changes) {
    const raced = await normalOutgoingByKey(env, identity.userId, input.key); if (raced) return replayNormalOutgoing(raced, hash);
    if (claim) throw new HttpError(409, "send_job_reservation_denied");
    await assertDraftSend(env, identity, input.draft, contentHash, accountId);
    await resolveAssets(env, identity, input.attachments);
    throw new HttpError(409, "normal_send_reservation_denied");
  }
  const result = await sendSmtp(endpoint, config.username, credential.authentication, { from: account.email_address, recipients, mime });
  try {
    const write = await env.DB.prepare("UPDATE normal_outgoing_messages SET state=?,error_code=?,updated_at=? WHERE id=? AND user_id=? AND state='pending'")
      .bind(result.state, result.error, unixNow(), id, identity.userId).run();
    if (!write.meta.changes) return replayNormalOutgoing((await normalOutgoingByKey(env, identity.userId, input.key)) ?? row, hash);
  } catch { return replayNormalOutgoing({ ...row, state: "unknown", error_code: "normal_send_storage_failed" }, hash); }
  return replayNormalOutgoing({ ...row, state: result.state, error_code: result.error, updated_at: unixNow() }, hash, true);
}
