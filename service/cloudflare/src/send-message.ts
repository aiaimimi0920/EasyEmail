import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { ownedMailbox } from "./mailbox-sync";
import { decryptCredential } from "./mailbox-vault";
import { outgoingByKey, replayOutgoing, type OutgoingRow } from "./outgoing-store";
import { connectProvider } from "./providers/registry";
import { assertMailboxUsable } from "./mailbox-access";
import { assertProviderRevision, PROVIDER_REVISION_FENCE } from "./providers/settings";
import { sendQuotaFence } from "./send-quota-fence";
import { MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";
import { assertDraftSend, draftSendFence, reserveDraftSend } from "./draft-send";
import { allRecipients, recipientsJson, toList } from "./outgoing-recipients";
import { outboxFence } from "./outbox-references";
import { outgoingAssets } from "./outbox-sending";
import { resolveAssets } from "./outbox-store";
import { sendInput, sendHashes, type SendInput } from "./send-input";
import { prepareSend } from "./send-preparation";
import { jobSendFence, reserveJobSend, type JobClaim } from "./send-job-reservation";

export async function sendMessage(request: Request, env: Env, identity: Identity, mailboxId: string): Promise<Response> {
  requireWriteScope(request, env, identity, "messages:send");
  const input = await sendInput(request);
  if (input.attachments.length) requireScope(identity, "attachments:read");
  if (input.draft) requireWriteScope(request, env, identity, "drafts:write");
  return executeSend(env, identity, mailboxId, input);
}

// Only internal runners can provide a claim. HTTP input never controls this fence.
export async function executeSend(env: Env, identity: Identity, mailboxId: string, input: SendInput, claim?: JobClaim): Promise<Response> {
  const { contentHash, hash } = await sendHashes(mailboxId, input);
  const previous = await outgoingByKey(env, identity, input.key);
  if (previous) return replayOutgoing(previous, hash);
  if (!claim) await assertDraftSend(env, identity, input.draft, contentHash);
  const { mailbox, config, replyId, threading } = await prepareSend(env, identity, mailboxId, input);
  const recipients = allRecipients(input), count = recipients.length, recipientJson = recipientsJson(input);
  const files = await outgoingAssets(env, identity, input.attachments), assetFence = outboxFence(identity.userId, input.attachments);
  const attachmentJson = files.manifests.length ? JSON.stringify(files.manifests) : null;
  const provider = await connectProvider(env, config);
  if (!provider.send) throw new HttpError(409, "sending_disabled");
  const credential = config.sendTransport === "worker" ? await decryptCredential(env, mailbox, mailbox.credential_cipher) : {};
  if (config.sendTransport === "worker" && !credential.token) throw new HttpError(503, "mailbox_credential_unavailable");
  const now = unixNow(), id = crypto.randomUUID();
  const quota = sendQuotaFence(identity.userId, now, count);
  const draftFence = draftSendFence(identity, claim ? null : input.draft, contentHash), jobFence = jobSendFence(claim);
  // SQLite serializes this unique guard and all quota checks in one write statement.
  // Charge every reserved recipient, including rejection/unknown; no refund or retry queue.
  const reservation = env.DB.prepare(`INSERT INTO outgoing_messages
    (id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,from_address,to_address,subject,text_body,
      reply_message_id,threading,state,created_at,updated_at,recipients_json,recipient_count,attachments_json)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?,?,? WHERE
      EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ? AND status = 'active' AND disabled_at IS NULL AND released_at IS NULL AND ${MAILBOX_EXPIRY_FENCE}) AND
      EXISTS (SELECT 1 FROM users WHERE id=? AND status='active') AND ${jobFence.sql} AND
      (? IS NULL OR EXISTS (SELECT 1 FROM messages WHERE id = ? AND user_id = ? AND mailbox_id = ? AND trashed_at IS NULL AND purged_at IS NULL)) AND
      ${quota.sql} AND ${PROVIDER_REVISION_FENCE} AND ${draftFence.sql} AND ${assetFence.sql}
    ON CONFLICT(user_id, request_key) DO NOTHING`)
    .bind(id, identity.userId, mailboxId, input.key, hash, config.id, config.sendTransport, mailbox.address, toList(input)[0],
      input.subject, input.text, input.reply, threading, now, now, recipientJson, count, attachmentJson, mailboxId, identity.userId, identity.userId, ...jobFence.values,
      input.reply, input.reply, identity.userId, mailboxId, ...quota.values, config.id, config.revision, ...draftFence.values, ...assetFence.values);
  const reserved = claim ? await reserveJobSend(env, claim, id, reservation) : await reserveDraftSend(env, identity, input.draft, id, reservation);
  if (!reserved.meta.changes) {
    const duplicate = await outgoingByKey(env, identity, input.key);
    if (duplicate) return replayOutgoing(duplicate, hash);
    if (claim) throw new HttpError(409, "send_job_reservation_denied");
    await resolveAssets(env, identity, input.attachments);
    await assertDraftSend(env, identity, input.draft, contentHash);
    await assertProviderRevision(env, config);
    assertMailboxUsable(await ownedMailbox(env, identity, mailboxId));
    if (input.reply && !await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND user_id = ? AND mailbox_id = ? AND trashed_at IS NULL AND purged_at IS NULL")
      .bind(input.reply, identity.userId, mailboxId).first()) throw new HttpError(400, "invalid_reply_source");
    throw new HttpError(429, "send_quota_exceeded");
  }
  const row = { id, user_id: identity.userId, mailbox_id: mailboxId, request_key: input.key, request_hash: hash,
    provider_id: config.id, transport: config.sendTransport, from_address: mailbox.address, to_address: toList(input)[0],
    recipients_json: recipientJson, recipient_count: count, attachments_json: attachmentJson,
    subject: input.subject, text_body: input.text, reply_message_id: input.reply, threading,
    state: "pending", error_code: null, created_at: now, updated_at: now } as OutgoingRow;
  let state: OutgoingRow["state"] = "accepted", errorCode: string | null = null;
  try { await provider.send({ from: mailbox.address, to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text, replyMessageId: replyId,
    ...(files.attachments.length ? { attachments: files.attachments } : {}) }, credential); }
  catch (error) {
    errorCode = error instanceof HttpError ? error.code : "send_outcome_unknown";
    state = ["provider_auth_failed", "provider_rate_limited"].includes(errorCode) ? "rejected" : "unknown";
  }
  try {
    const result = await env.DB.prepare(`UPDATE outgoing_messages SET state = ?, error_code = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND state = 'pending'`).bind(state, errorCode, unixNow(), id, identity.userId).run();
    if (!result.meta.changes) return replayOutgoing((await outgoingByKey(env, identity, input.key)) ?? row, hash);
  } catch {
    state = "unknown"; errorCode = "send_storage_failed";
    try { await env.DB.prepare(`UPDATE outgoing_messages SET state = 'unknown', error_code = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'`).bind(errorCode, unixNow(), id).run(); } catch { /* Durable guard still forbids another dispatch. */ }
  }
  return replayOutgoing({ ...row, state, error_code: errorCode, updated_at: unixNow() }, hash, true);
}
