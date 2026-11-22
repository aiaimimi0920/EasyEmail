import { addressText, recipientFields, type RecipientEditor } from "./compose-recipients";
import { outboxRefs, type OutboxAttachment } from "./outbox-attachments";

export interface ComposeDraft extends RecipientEditor {
  mailboxId: string; subject: string; text: string; replyToMessageId?: string; attachments?: OutboxAttachment[];
  normalAccountId?: string; accountRevision?: number;
}
export interface CloudDraft {
  id: string; revision: number; state: "editing" | "submitted"; mailboxId: string | null;
  to: string | string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; replyToMessageId: string | null;
  outgoingId: string | null; createdAt: number; updatedAt: number;
  attachments?: OutboxAttachment[];
  normalAccountId?: string; accountRevision?: number;
}
export type DraftSummary = Omit<CloudDraft, "text">;
export const emptyDraft = (): ComposeDraft => ({ mailboxId: "", to: "", cc: "", bcc: "", subject: "", text: "" });
export const composeDraft = (value: CloudDraft): ComposeDraft => ({ mailboxId: value.mailboxId ?? "", to: addressText(value.to),
  cc: (value.cc ?? []).join(", "), bcc: (value.bcc ?? []).join(", "),
  subject: value.subject, text: value.text, ...(value.attachments?.length ? { attachments: value.attachments } : {}),
  ...(value.replyToMessageId ? { replyToMessageId: value.replyToMessageId } : {}),
  ...(value.normalAccountId ? { normalAccountId: value.normalAccountId, accountRevision: value.accountRevision } : {}) });
type DraftFields = ReturnType<typeof recipientFields> & {
  mailboxId?: string | null; accountRevision?: number; subject: string; text: string;
  replyToMessageId?: string | null; attachments?: ReturnType<typeof outboxRefs>;
};
export const draftFields = (value: ComposeDraft): DraftFields => value.normalAccountId
  ? { accountRevision: value.accountRevision, ...recipientFields(value), subject: value.subject, text: value.text,
    ...(value.replyToMessageId ? { replyToMessageId: value.replyToMessageId } : {}),
    ...(value.attachments?.length ? { attachments: outboxRefs(value.attachments) } : {}) }
  : ({ mailboxId: value.mailboxId || null, ...recipientFields(value),
  subject: value.subject, text: value.text, replyToMessageId: value.replyToMessageId ?? null,
  ...(value.attachments?.length ? { attachments: outboxRefs(value.attachments) } : {}) });
export const draftKey = (value: ComposeDraft) => JSON.stringify(value.normalAccountId ? [value.normalAccountId, draftFields(value)] : draftFields(value));
