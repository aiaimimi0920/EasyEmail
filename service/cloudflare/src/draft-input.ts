import { HttpError, readJson, textField } from "./http";
import { parseRecipients, type RecipientFields } from "./outgoing-recipients";
import { outgoingPayloadParts, parseOutboxReferences } from "./outbox-references";
import type { OutboxReference } from "./outbox-model";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface DraftContent extends RecipientFields {
  mailboxId: string | null; subject: string; text: string; replyToMessageId: string | null; attachments?: OutboxReference[];
  normalAccountId?: string; accountRevision?: number;
  normalReplyToMessageId?: string | null;
}
export interface DraftInput extends DraftContent { expectedRevision: number }

export function draftRevision(value: unknown, allowZero = true): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1) || (value as number) >= Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, "invalid_draft_request");
  }
  return value as number;
}

export async function draftInput(request: Request, normalAccountId?: string): Promise<DraftInput> {
  const body = await readJson(request);
  const fields = normalAccountId ? ["expectedRevision", "accountRevision", "to", "cc", "bcc", "subject", "text", "replyToMessageId", "attachments"]
    : ["expectedRevision", "mailboxId", "to", "cc", "bcc", "subject", "text", "replyToMessageId", "attachments"];
  if (Object.keys(body).some(key => !fields.includes(key))) {
    throw new HttpError(400, "invalid_draft_request");
  }
  const mailboxId = body.mailboxId ?? null, replyToMessageId = body.replyToMessageId ?? null;
  if ([mailboxId, replyToMessageId].some(value => value !== null && (typeof value !== "string" || !UUID.test(value)))
    || (replyToMessageId && !mailboxId && !normalAccountId)) throw new HttpError(400, "invalid_draft_request");
  const recipients = parseRecipients(body, true), subject = textField(body, "subject", 0, 200), text = textField(body, "text", 0, 6000);
  if (/[\x00-\x1f\x7f]/.test(subject) || text.includes("\0")) throw new HttpError(400, "invalid_draft_request");
  if ([subject, text].some(value => new TextDecoder().decode(new TextEncoder().encode(value)) !== value)) throw new HttpError(400, "invalid_draft_request");
  return { expectedRevision: draftRevision(body.expectedRevision), mailboxId: mailboxId as string | null,
    replyToMessageId: normalAccountId ? null : replyToMessageId as string | null, ...recipients, subject, text, attachments: parseOutboxReferences(body.attachments),
    ...(normalAccountId ? { normalAccountId, accountRevision: draftRevision(body.accountRevision, false), normalReplyToMessageId: replyToMessageId as string | null } : {}) };
}

export const draftContentKey = (input: DraftContent) => JSON.stringify(input.normalAccountId
  ? ["normal-draft-v1", input.normalAccountId, input.accountRevision, input.to, input.cc, input.bcc, input.subject, input.text,
    ...(input.normalReplyToMessageId ? ["normal-reply-v1", input.normalReplyToMessageId] : []),
    ...(input.attachments?.length ? ["normal-attachments-v1", input.attachments.map(({ id, version }) => ({ id, version }))] : [])]
  : outgoingPayloadParts(input.mailboxId, input, input.subject, input.text, input.replyToMessageId));
