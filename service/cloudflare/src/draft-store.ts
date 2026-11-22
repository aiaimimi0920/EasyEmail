import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import type { DraftContent, DraftInput } from "./draft-input";
import { draftContentKey } from "./draft-input";
import { tokenHash } from "./security";
import { recipientsJson, storedRecipients, toList } from "./outgoing-recipients";
import { outboxFence, storedOutbox } from "./outbox-references";
import { resolveAssets } from "./outbox-store";
import { requireScope } from "./identity";
import { assertNormalDraftSource, draftSourceFence, draftSourceMatches, draftSourceScope } from "./draft-source";
import { normalReplyFence, resolveNormalReply } from "./normal-reply";

export interface DraftRow {
  id: string; user_id: string; revision: number; state: "editing" | "submitted" | "deleted";
  mailbox_id: string | null; to_address: string; recipients_json?: string | null; subject: string; text_body: string;
  reply_message_id: string | null; content_hash: string; outgoing_id: string | null; created_at: number; updated_at: number;
  attachments_json?: string | null;
  normal_account_id?: string | null; normal_account_revision?: number | null;
  normal_reply_message_id?: string | null;
  normal_attachments_json?: string | null;
}
export const DRAFT_LIMIT = 100;
export const draftView = (row: DraftRow, detail = true) => ({ id: row.id, revision: row.revision, state: row.state,
  mailboxId: row.mailbox_id, ...storedRecipients(row), attachments: storedOutbox({ attachments_json: row.normal_account_id ? row.normal_attachments_json : row.attachments_json }), subject: row.subject, ...(detail ? { text: row.text_body } : {}),
  replyToMessageId: row.normal_account_id ? row.normal_reply_message_id ?? null : row.reply_message_id, outgoingId: row.outgoing_id, createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.normal_account_id ? { normalAccountId: row.normal_account_id, accountRevision: row.normal_account_revision } : {}) });
export const draftRow = (env: Env, identity: Identity, id: string) => env.DB.prepare("SELECT * FROM drafts WHERE user_id=? AND id=?")
  .bind(identity.userId, id).first<DraftRow>();

export async function assertDraftReferences(env: Env, identity: Identity, input: DraftContent) {
  await assertNormalDraftSource(env, identity, input);
  if (input.mailboxId && !await env.DB.prepare("SELECT id FROM mailboxes WHERE user_id=? AND id=?")
    .bind(identity.userId, input.mailboxId).first()) throw new HttpError(404, "not_found");
  if (input.replyToMessageId && !await env.DB.prepare("SELECT id FROM messages WHERE user_id=? AND mailbox_id=? AND id=? AND purged_at IS NULL")
    .bind(identity.userId, input.mailboxId, input.replyToMessageId).first()) throw new HttpError(400, "invalid_reply_source");
  return input.normalReplyToMessageId ? resolveNormalReply(env, identity, input.normalAccountId!, input.normalReplyToMessageId) : null;
}

export async function saveDraft(env: Env, identity: Identity, id: string, input: DraftInput): Promise<{ row: DraftRow; created: boolean }> {
  if (input.attachments?.length) requireScope(identity, "attachments:read");
  if (input.normalReplyToMessageId) requireScope(identity, "messages:read");
  const hash = await tokenHash(draftContentKey(input)), previous = await draftRow(env, identity, id);
  if (previous && !draftSourceMatches(previous, input.normalAccountId)) throw new HttpError(404, "not_found");
  const replay = (row: DraftRow | null) => row?.state === "editing" && row.revision === input.expectedRevision + 1 && row.content_hash === hash;
  if (replay(previous)) return { row: previous!, created: false };
  if (previous && (previous.state !== "editing" || previous.revision !== input.expectedRevision)) throw new HttpError(409, "draft_changed");
  if (!previous && input.expectedRevision !== 0) throw new HttpError(404, "not_found");
  const reply = await assertDraftReferences(env, identity, input), replyFence = normalReplyFence(identity, reply);
  const references = input.attachments ?? [], resolved = await resolveAssets(env, identity, references), fence = outboxFence(identity.userId, references);
  const source = draftSourceFence(identity, input), scope = draftSourceScope(input.normalAccountId);
  const attachments = resolved.manifests.length ? JSON.stringify(resolved.manifests) : null;
  const now = unixNow(), to = toList(input)[0] ?? "", recipients = recipientsJson(input);
  const result = previous ? await env.DB.prepare(`UPDATE drafts SET revision=revision+1,mailbox_id=?,to_address=?,subject=?,text_body=?,
    reply_message_id=?,content_hash=?,updated_at=?,recipients_json=?,attachments_json=?,normal_account_revision=?,normal_reply_message_id=?,normal_attachments_json=?
    WHERE user_id=? AND id=? AND state='editing' AND revision=? AND ${scope.sql} AND ${source.sql} AND ${fence.sql} AND ${replyFence.sql}`)
    .bind(input.mailboxId, to, input.subject, input.text, input.replyToMessageId, hash, now, recipients, input.normalAccountId ? null : attachments, input.accountRevision ?? null, input.normalReplyToMessageId ?? null, input.normalAccountId ? attachments : null,
      identity.userId, id, input.expectedRevision, ...scope.values, ...source.values, ...fence.values, ...replyFence.values).run()
    : await env.DB.prepare(`INSERT INTO drafts(user_id,id,revision,mailbox_id,to_address,subject,text_body,reply_message_id,content_hash,created_at,updated_at,recipients_json,attachments_json,normal_account_id,normal_account_revision,normal_reply_message_id,normal_attachments_json)
      SELECT ?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM drafts WHERE user_id=? AND state!='deleted') < ${DRAFT_LIMIT} AND ${source.sql} AND ${fence.sql} AND ${replyFence.sql}
      ON CONFLICT(user_id,id) DO NOTHING`)
      .bind(identity.userId, id, input.mailboxId, to, input.subject, input.text, input.replyToMessageId, hash, now, now, recipients, input.normalAccountId ? null : attachments,
        input.normalAccountId ?? null, input.accountRevision ?? null, input.normalReplyToMessageId ?? null, input.normalAccountId ? attachments : null, identity.userId, ...source.values, ...fence.values, ...replyFence.values).run();
  const row = await draftRow(env, identity, id);
  if (!result.meta.changes && !replay(row)) {
    await assertNormalDraftSource(env, identity, input); await resolveAssets(env, identity, references);
    throw new HttpError(409, row ? "draft_changed" : "draft_limit");
  }
  if (!row || row.state !== "editing" || row.revision !== input.expectedRevision + 1 || row.content_hash !== hash) throw new HttpError(409, "draft_changed");
  return { row, created: !previous && !!result.meta.changes };
}

export async function removeDraft(env: Env, identity: Identity, id: string, revision: number, accountId?: string) {
  const scope = draftSourceScope(accountId);
  const result = await env.DB.prepare(`UPDATE drafts SET revision=revision+1,state='deleted',mailbox_id=NULL,to_address='',subject='',text_body='',
    reply_message_id=NULL,normal_reply_message_id=NULL,content_hash='',recipients_json=NULL,attachments_json=NULL,normal_attachments_json=NULL,updated_at=? WHERE user_id=? AND id=? AND revision=? AND state!='deleted' AND ${scope.sql}`)
    .bind(unixNow(), identity.userId, id, revision, ...scope.values).run();
  const row = await draftRow(env, identity, id);
  if (!row || !draftSourceMatches(row, accountId)) throw new HttpError(404, "not_found");
  if (!result.meta.changes && !(row.state === "deleted" && row.revision === revision + 1)) throw new HttpError(409, "draft_changed");
  return { id, revision: row.revision, state: "deleted" as const };
}
