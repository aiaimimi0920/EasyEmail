export type MailListSortMode = "newest" | "oldest" | "largest" | "smallest";

export type SortableMailMessage = {
  message_id: string;
  observed_at: string;
};

export type MailListMessage = SortableMailMessage & {
  subject: string;
  from_address: string;
  received_address: string;
  snippet: string;
  body_text?: string | null;
  labels: readonly string[];
};

export type ConversationMessage = SortableMailMessage & {
  subject: string;
  from_address: string;
  received_address: string;
  snippet?: string;
  body_text?: string | null;
  labels?: readonly string[];
  local_folder: string;
  sourceId: string;
  thread_key?: string | null;
  is_read: boolean;
  is_starred: boolean;
};

export type MailConversationSummary<
  TMessage extends ConversationMessage,
  TVerificationCode,
> = {
  key: string;
  subject: string;
  latestMessage: TMessage;
  messages: TMessage[];
  unreadCount: number;
  starred: boolean;
  verificationCode: TVerificationCode | null;
};

export type MailboxView =
  | "inbox"
  | "drafts"
  | "sent"
  | "starred"
  | "archive"
  | "spam"
  | "trash"
  | "all-mail"
  | "newsletters"
  | "folders"
  | "labels";

export type MailRailItemId = "compose" | MailboxView;

export type MailboxMessage = {
  local_folder: string;
  labels: readonly string[];
  newsletter_subscription_id: string | null;
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
};

const BUILT_IN_MAIL_FOLDERS = new Set(["inbox", "drafts", "sent", "archive", "spam", "trash"]);

export function normalizeMailToken(value: string): string {
  return value.trim().toLowerCase();
}

function isNewsletterMessage(message: MailboxMessage): boolean {
  const subscriptionId = message.newsletter_subscription_id?.trim();
  return Boolean(subscriptionId) ||
    message.labels.some((label) => normalizeMailToken(label) === "newsletters");
}

export function filterVisibleMailMessagesForMailbox<T extends MailboxMessage>(
  messages: readonly T[],
  mailboxView: MailboxView,
): T[] {
  switch (mailboxView) {
    case "inbox":
      return messages.filter(
        (message) =>
          normalizeMailToken(message.local_folder) === "inbox" && !message.is_archived,
      );
    case "starred":
      return messages.filter((message) => message.is_starred);
    case "archive":
      return messages.filter(
        (message) =>
          message.is_archived || normalizeMailToken(message.local_folder) === "archive",
      );
    case "spam":
      return messages.filter(
        (message) => normalizeMailToken(message.local_folder) === "spam",
      );
    case "trash":
      return messages.filter(
        (message) => normalizeMailToken(message.local_folder) === "trash",
      );
    case "newsletters":
      return messages.filter(isNewsletterMessage);
    case "folders":
      return messages.filter(
        (message) => !BUILT_IN_MAIL_FOLDERS.has(normalizeMailToken(message.local_folder)),
      );
    case "labels":
      return messages.filter((message) => message.labels.length > 0);
    case "all-mail":
      return [...messages];
    case "drafts":
      return messages.filter(
        (message) => normalizeMailToken(message.local_folder) === "drafts",
      );
    case "sent":
      return messages.filter(
        (message) => normalizeMailToken(message.local_folder) === "sent",
      );
  }
}

export function buildMailRailCounts(
  messages: readonly MailboxMessage[],
): Record<MailRailItemId, number | null> {
  const counts: Record<MailRailItemId, number | null> = {
    compose: null,
    inbox: 0,
    drafts: 0,
    sent: 0,
    starred: 0,
    archive: 0,
    spam: 0,
    trash: 0,
    "all-mail": 0,
    newsletters: 0,
    folders: 0,
    labels: 0,
  };

  for (const message of messages) {
    const unread = !message.is_read;
    const localFolder = normalizeMailToken(message.local_folder);
    const isInbox = localFolder === "inbox" && !message.is_archived;
    const isArchive = message.is_archived || localFolder === "archive";
    const isCustomFolder = !BUILT_IN_MAIL_FOLDERS.has(localFolder);

    if (localFolder === "drafts") counts.drafts = (counts.drafts ?? 0) + 1;
    if (localFolder === "sent") counts.sent = (counts.sent ?? 0) + 1;
    if (!unread) continue;

    if (isInbox) counts.inbox = (counts.inbox ?? 0) + 1;
    if (message.is_starred) counts.starred = (counts.starred ?? 0) + 1;
    if (isArchive) counts.archive = (counts.archive ?? 0) + 1;
    if (localFolder === "spam") counts.spam = (counts.spam ?? 0) + 1;
    if (localFolder === "trash") counts.trash = (counts.trash ?? 0) + 1;
    counts["all-mail"] = (counts["all-mail"] ?? 0) + 1;
    if (isNewsletterMessage(message)) counts.newsletters = (counts.newsletters ?? 0) + 1;
    if (isCustomFolder) counts.folders = (counts.folders ?? 0) + 1;
    if (message.labels.length > 0) counts.labels = (counts.labels ?? 0) + 1;
  }

  return counts;
}

export function visibleMailMessageSortTimestamp(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  const withoutTimezoneComment = trimmed.replace(/\s+\([A-Z]{2,5}\)$/u, "");
  const parsedWithoutComment = Date.parse(withoutTimezoneComment);
  return Number.isFinite(parsedWithoutComment) ? parsedWithoutComment : 0;
}

export function sortVisibleMailMessagesByTime<T extends SortableMailMessage>(
  messages: readonly T[],
): T[] {
  return [...messages].sort((left, right) => {
    const byObservedAt =
      visibleMailMessageSortTimestamp(right.observed_at) -
      visibleMailMessageSortTimestamp(left.observed_at);
    if (byObservedAt !== 0) {
      return byObservedAt;
    }
    const byObservedText = right.observed_at.localeCompare(left.observed_at);
    return byObservedText !== 0
      ? byObservedText
      : right.message_id.localeCompare(left.message_id);
  });
}

export function parseVisibleMailMessageDate(value: string): Date | null {
  const timestamp = visibleMailMessageSortTimestamp(value);
  return timestamp > 0 ? new Date(timestamp) : null;
}

export function visibleMailMessageHasAttachment(message: MailListMessage): boolean {
  const searchable = [message.subject, message.snippet, ...message.labels]
    .join(" ")
    .toLowerCase();
  return (
    searchable.includes("attachment") ||
    searchable.includes("attached") ||
    searchable.includes("附件") ||
    searchable.includes("[file]") ||
    searchable.includes("📎")
  );
}

function estimateVisibleMailMessageSize(message: MailListMessage): number {
  return [
    message.subject,
    message.from_address,
    message.received_address,
    message.snippet,
    message.body_text ?? "",
    ...message.labels,
  ].join("").length;
}

function estimateConversationMessageSize(message: ConversationMessage): number {
  return [
    message.subject,
    message.from_address,
    message.received_address,
    message.snippet ?? "",
    message.body_text ?? "",
    message.local_folder,
    message.thread_key ?? "",
    ...(message.labels ?? []),
  ].join("").length;
}

export function sortMailListMessages<T extends MailListMessage>(
  messages: readonly T[],
  sortMode: MailListSortMode,
): T[] {
  return [...messages].sort((left, right) => {
    if (sortMode === "largest" || sortMode === "smallest") {
      const leftSize = estimateVisibleMailMessageSize(left);
      const rightSize = estimateVisibleMailMessageSize(right);
      const diff = sortMode === "largest" ? rightSize - leftSize : leftSize - rightSize;
      if (diff !== 0) {
        return diff;
      }
    } else {
      const timeDiff =
        visibleMailMessageSortTimestamp(right.observed_at) -
        visibleMailMessageSortTimestamp(left.observed_at);
      if (timeDiff !== 0) {
        return sortMode === "newest" ? timeDiff : -timeDiff;
      }
    }

    const observedTextDiff =
      sortMode === "oldest"
        ? left.observed_at.localeCompare(right.observed_at)
        : right.observed_at.localeCompare(left.observed_at);
    if (observedTextDiff !== 0) {
      return observedTextDiff;
    }
    return right.message_id.localeCompare(left.message_id);
  });
}

export function normalizeMailConversationSubject(subject: string): string {
  let normalized = subject.trim().toLowerCase();
  for (let index = 0; index < 8; index += 1) {
    const next = normalized
      .replace(/^\s*(re|fw|fwd|回复|答复|转发)\s*[:：]\s*/i, "")
      .replace(/^\s*\[[^\]]*(re|fw|fwd|回复|答复|转发)[^\]]*\]\s*/i, "")
      .trim();
    if (next === normalized) {
      break;
    }
    normalized = next;
  }
  return normalized || "(no subject)";
}

export function extractEmailAddress(value: string): string {
  const trimmed = value.trim();
  const angleAddress = trimmed.match(/<([^>]+)>/);
  return (angleAddress?.[1] ?? trimmed).trim();
}

export function displayNameFromAddress(value: string): string {
  const trimmed = value.trim();
  const angleAddress = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (angleAddress?.[1]) {
    return angleAddress[1].trim();
  }
  const email = extractEmailAddress(trimmed);
  return email.split("@")[0] || trimmed || "Unknown sender";
}

function mailConversationCounterpartyForMessage(message: ConversationMessage): string {
  const fromAddress = extractEmailAddress(message.from_address).toLowerCase();
  const receivedAddress = extractEmailAddress(message.received_address).toLowerCase();
  if (message.local_folder === "sent" && receivedAddress) {
    return receivedAddress;
  }
  if (message.local_folder === "drafts") {
    return `draft:${message.message_id}`;
  }
  return fromAddress || receivedAddress || message.message_id;
}

export function mailConversationKeyForMessage(message: ConversationMessage): string {
  if (message.local_folder === "drafts") {
    return `draft:${message.message_id}`;
  }
  if (message.thread_key?.trim()) {
    return [message.sourceId, message.thread_key.trim().toLowerCase()].join("::");
  }
  const subject = normalizeMailConversationSubject(message.subject);
  const counterparty = mailConversationCounterpartyForMessage(message);
  return [message.sourceId, subject, counterparty].join("::");
}

export function buildMailConversations<
  TMessage extends ConversationMessage,
  TVerificationCode,
>(
  messages: readonly TMessage[],
  verificationCodesByMessageId: ReadonlyMap<string, TVerificationCode>,
  sortMode: MailListSortMode = "newest",
): MailConversationSummary<TMessage, TVerificationCode>[] {
  const grouped = new Map<string, TMessage[]>();
  for (const message of messages) {
    const key = mailConversationKeyForMessage(message);
    const conversationMessages = grouped.get(key);
    if (conversationMessages) {
      conversationMessages.push(message);
    } else {
      grouped.set(key, [message]);
    }
  }

  return Array.from(grouped.entries())
    .map(([key, conversationMessages]) => {
      const messagesByTime = sortVisibleMailMessagesByTime(conversationMessages);
      const latestMessage = messagesByTime[0];
      let verificationCode: TVerificationCode | null = null;
      for (const message of messagesByTime) {
        const candidate = verificationCodesByMessageId.get(message.message_id);
        if (candidate !== undefined) {
          verificationCode = candidate;
          break;
        }
      }
      return {
        conversation: {
          key,
          subject: latestMessage.subject,
          latestMessage,
          messages: [...messagesByTime].reverse(),
          unreadCount: messagesByTime.filter((message) => !message.is_read).length,
          starred: messagesByTime.some((message) => message.is_starred),
          verificationCode,
        },
        estimatedSize: messagesByTime.reduce(
          (total, message) => total + estimateConversationMessageSize(message),
          0,
        ),
      };
    })
    .sort((left, right) => {
      if (sortMode === "largest" || sortMode === "smallest") {
        const sizeDiff =
          sortMode === "largest"
            ? right.estimatedSize - left.estimatedSize
            : left.estimatedSize - right.estimatedSize;
        if (sizeDiff !== 0) {
          return sizeDiff;
        }
      }
      const timeDiff =
        visibleMailMessageSortTimestamp(right.conversation.latestMessage.observed_at) -
        visibleMailMessageSortTimestamp(left.conversation.latestMessage.observed_at);
      if (timeDiff !== 0) {
        return sortMode === "oldest" ? -timeDiff : timeDiff;
      }
      const observedTextDiff =
        sortMode === "oldest"
          ? left.conversation.latestMessage.observed_at.localeCompare(
              right.conversation.latestMessage.observed_at,
            )
          : right.conversation.latestMessage.observed_at.localeCompare(
              left.conversation.latestMessage.observed_at,
            );
      if (observedTextDiff !== 0) {
        return observedTextDiff;
      }
      return sortMode === "oldest"
        ? left.conversation.latestMessage.message_id.localeCompare(
            right.conversation.latestMessage.message_id,
          )
        : right.conversation.latestMessage.message_id.localeCompare(
            left.conversation.latestMessage.message_id,
          );
    })
    .map(({ conversation }) => conversation);
}
