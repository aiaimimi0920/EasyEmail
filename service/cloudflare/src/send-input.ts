import { HttpError, readJson, textField } from "./http";
import { draftSendInput } from "./draft-send";
import { parseRecipients } from "./outgoing-recipients";
import { outgoingPayloadParts, parseOutboxReferences } from "./outbox-references";
import { tokenHash } from "./security";

export function sendInputData(body: Record<string, unknown>, key: string) {
  if (Object.keys(body).some(name => !["to", "cc", "bcc", "subject", "text", "replyToMessageId", "draftId", "draftRevision", "attachments"].includes(name))) throw new HttpError(400, "invalid_send_request");
  const recipients = parseRecipients(body);
  const subject = textField(body, "subject", 1, 200), text = textField(body, "text", 1, 6000);
  if (!subject.trim() || /[\x00-\x1f\x7f]/.test(subject) || !text.trim() || text.includes("\0")) throw new HttpError(400, "invalid_send_request");
  const reply = body.replyToMessageId ?? null;
  if (reply !== null && (typeof reply !== "string" || !/^[0-9a-f-]{36}$/.test(reply))) throw new HttpError(400, "invalid_reply_source");
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  return { ...recipients, subject, text, reply: reply as string | null, key, draft: draftSendInput(body), attachments: parseOutboxReferences(body.attachments) };
}
export type SendInput = ReturnType<typeof sendInputData>;
export async function sendInput(request: Request) {
  return sendInputData(await readJson(request), request.headers.get("idempotency-key") ?? "");
}
export async function sendHashes(mailboxId: string, input: SendInput) {
  const content = outgoingPayloadParts(mailboxId, input, input.subject, input.text, input.reply);
  const contentHash = await tokenHash(JSON.stringify(content));
  return { contentHash, hash: input.draft ? await tokenHash(JSON.stringify([...content, input.draft.id, input.draft.revision])) : contentHash };
}
