import { HttpError } from "./http";
import { normalRevision } from "./normal-account-input";
import { smtpRevision } from "./smtp-config-input";
import { sendInputData, type SendInput } from "./send-input";
import { draftContentKey } from "./draft-input";
import { tokenHash } from "./security";

export interface NormalSendInput extends SendInput { accountRevision: number; smtpRevision: number }
export function normalSendInput(body: Record<string, unknown>, key: string): NormalSendInput {
  const accountRevision = normalRevision(body), revision = smtpRevision(body.smtpRevision);
  const { expectedRevision: _accountRevision, smtpRevision: _smtpRevision, ...content } = body;
  // Scheduling belongs to the queue endpoint; direct sending must not silently discard intent.
  if (Object.keys(content).some(k => !["to", "cc", "bcc", "subject", "text", "draftId", "draftRevision", "replyToMessageId", "attachments"].includes(k)) || !accountRevision || !revision) throw new HttpError(400, "invalid_send_request");
  const input = sendInputData(content, key);
  if ([input.subject, input.text].some(value => new TextDecoder().decode(new TextEncoder().encode(value)) !== value)) throw new HttpError(400, "invalid_send_request");
  return { ...input, accountRevision, smtpRevision: revision };
}
export async function normalSendHashes(accountId: string, input: NormalSendInput) {
  const parts = ["normal-smtp-send-v1", accountId, input.accountRevision, input.smtpRevision, input.to, input.cc, input.bcc, input.subject, input.text];
  const draft = input.draft ? [...parts, input.draft.id, input.draft.revision] : parts;
  const reply = input.reply ? [...draft, "normal-reply-v1", input.reply] : draft;
  return { hash: await tokenHash(JSON.stringify(input.attachments.length ? [...reply, "normal-attachments-v1", input.attachments] : reply)),
    contentHash: await tokenHash(draftContentKey({ ...input, mailboxId: null, replyToMessageId: null, normalAccountId: accountId, accountRevision: input.accountRevision, normalReplyToMessageId: input.reply })) };
}
