import type {
  AnonymousMessageDto,
  MailSource,
  TempMailboxDto,
  VisibleMailMessage,
} from "./appTypes.ts";

const TEMP_MAILBOX_SOURCE_PREFIX = "temp:";

export function temporaryMailboxSourceId(mailboxId: string): string {
  return `${TEMP_MAILBOX_SOURCE_PREFIX}${mailboxId}`;
}

export function temporaryMailboxIdFromSourceId(sourceId: string): string | null {
  if (!sourceId.startsWith(TEMP_MAILBOX_SOURCE_PREFIX)) return null;
  return sourceId.slice(TEMP_MAILBOX_SOURCE_PREFIX.length) || null;
}

export function attachTemporaryMailboxSources(
  messages: readonly AnonymousMessageDto[],
  mailboxes: readonly TempMailboxDto[],
): VisibleMailMessage[] {
  const addressByMailboxId = new Map(
    mailboxes.map((mailbox) => [mailbox.id, mailbox.email_address]),
  );
  return messages.map((message) => ({
    ...message,
    sourceLabel:
      addressByMailboxId.get(message.temp_mailbox_id) ||
      message.received_address ||
      "临时邮箱",
    sourceId: temporaryMailboxSourceId(message.temp_mailbox_id),
  }));
}

export function buildTemporaryMailboxSources(
  mailboxes: readonly TempMailboxDto[],
  messages: readonly AnonymousMessageDto[],
): MailSource[] {
  const messageCounts = new Map<string, number>();
  for (const message of messages) {
    messageCounts.set(
      message.temp_mailbox_id,
      (messageCounts.get(message.temp_mailbox_id) ?? 0) + 1,
    );
  }
  return mailboxes.map((mailbox) => ({
    id: temporaryMailboxSourceId(mailbox.id),
    label: mailbox.email_address,
    meta: `${messageCounts.get(mailbox.id) ?? 0} 封邮件 / ${mailbox.provider_label}`,
    tone: "cyan",
  }));
}
