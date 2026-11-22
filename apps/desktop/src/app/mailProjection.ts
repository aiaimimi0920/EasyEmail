import type { AccountDto } from "../api/mailAccountClient.ts";
import {
  buildMailConversations,
  filterVisibleMailMessagesForMailbox,
  normalizeMailToken,
  sortMailListMessages,
  sortVisibleMailMessagesByTime,
  visibleMailMessageHasAttachment,
  type MailListSortMode,
} from "../mail/mailSelectors.ts";
import {
  detectInlineVerificationCode,
  mailSearchMessageMatchesAdvancedFilters,
  visibleMailMessageSearchText,
  type VerificationCodeDto,
} from "../mail/mailSearch.ts";
import { MAIL_SEARCH_OTHER_SCOPES, MAIL_SEARCH_PRIMARY_SCOPES } from "./appConfig.ts";
import { temporaryMailboxIdFromSourceId } from "./temporaryMailSources.ts";
import type {
  CodeBackedMailMessage,
  MailConversationSummary,
  MailboxView,
  MailListReadFilter,
  MailSearchScope,
  MailSearchScopeOption,
  MessageCache,
  SelectedMailTaxonomyFilter,
  VisibleMailMessage,
} from "./appTypes.ts";

export type MailProjectionInput = {
  mailSourceId: string;
  normalMessagesByAccount: MessageCache;
  promotedMessagesByAccount: MessageCache;
  mailboxView: MailboxView;
  selectedMailTaxonomyFilter: SelectedMailTaxonomyFilter;
  selectedNewsletterSubscription: { accountId: string; subscriptionId: string } | null;
  mailSearchStartDate: string;
  mailSearchEndDate: string;
  mailSearchSender: string;
  mailSearchRecipient: string;
  mailSearchAddress: string;
  mailSearchHasAttachment: boolean;
  onlyCodes: boolean;
  mailSearchQuery: string;
  mailSearchScope: MailSearchScope;
  recentCodes: VerificationCodeDto[];
  mailSearchFullText: boolean;
  mailListReadFilter: MailListReadFilter;
  mailListHasAttachmentOnly: boolean;
  mailListSortMode: MailListSortMode;
  mailSearchFolderFilter: string;
  tempVisibleMessages: VisibleMailMessage[];
  normalImapAccounts: AccountDto[];
  promotedAccounts: AccountDto[];
  allVisibleMailMessages: VisibleMailMessage[];
};

export type MailProjection = {
  visibleMailMessages: VisibleMailMessage[];
  mailSearchHasAdvancedCriteria: boolean;
  codeBackedMailMessages: CodeBackedMailMessage[];
  displayedMailMessages: VisibleMailMessage[];
  displayedMailConversations: MailConversationSummary[];
  displayedMailConversationMessages: VisibleMailMessage[];
  filteredMailSearchOtherScopes: MailSearchScopeOption[];
  mailSearchAddressOptions: Array<{ id: string; label: string }>;
  mailSearchResultLabel: string;
  displayedMailMessageKey: string;
};

function applyProjectionSearchScope(
  messages: VisibleMailMessage[],
  scope: MailSearchScope,
): VisibleMailMessage[] {
  return scope === "snoozed" || scope === "scheduled"
    ? []
    : filterVisibleMailMessagesForMailbox(messages, scope);
}

export function deriveMailProjection(input: MailProjectionInput): MailProjection {
  const visibleMailMessages: VisibleMailMessage[] = (() => {
    const tempMailboxId = temporaryMailboxIdFromSourceId(input.mailSourceId);
    if (tempMailboxId) {
      return input.tempVisibleMessages.filter(
        (message) => message.temp_mailbox_id === tempMailboxId,
      );
    }
    if (input.mailSourceId === "temp") {
      return input.tempVisibleMessages;
    }
    if (input.mailSourceId.startsWith("account:")) {
      const accountId = input.mailSourceId.slice("account:".length);
      const account = input.normalImapAccounts.find((item) => item.id === accountId) ?? null;
      return sortVisibleMailMessagesByTime(
        (input.normalMessagesByAccount[accountId] ?? []).map((message) => ({
          ...message,
          sourceLabel: account?.display_name ?? "普通邮箱",
          sourceId: `account:${accountId}`,
          account_id: accountId,
        })),
      );
    }
    if (input.mailSourceId.startsWith("promoted:")) {
      const accountId = input.mailSourceId.slice("promoted:".length);
      const account = input.promotedAccounts.find((item) => item.id === accountId) ?? null;
      return sortVisibleMailMessagesByTime(
        (input.promotedMessagesByAccount[accountId] ?? []).map((message) => ({
          ...message,
          sourceLabel: account?.display_name ?? "临时升级邮箱",
          sourceId: `promoted:${accountId}`,
          account_id: accountId,
        })),
      );
    }
    return input.allVisibleMailMessages;
  })();

  const mailboxVisibleMailMessages = filterVisibleMailMessagesForMailbox(
    visibleMailMessages,
    input.mailboxView,
  );
  const taxonomyFilter = input.selectedMailTaxonomyFilter;
  const taxonomyVisibleMailMessages =
    taxonomyFilter &&
    input.mailboxView === "folders" &&
    taxonomyFilter.kind === "folder"
      ? mailboxVisibleMailMessages.filter(
          (message) =>
            normalizeMailToken(message.local_folder) ===
            normalizeMailToken(taxonomyFilter.name),
        )
      : taxonomyFilter &&
          input.mailboxView === "labels" &&
          taxonomyFilter.kind === "label"
        ? mailboxVisibleMailMessages.filter((message) =>
            message.labels.some(
              (label) =>
                normalizeMailToken(label) ===
                normalizeMailToken(taxonomyFilter.name),
            ),
          )
        : mailboxVisibleMailMessages;
  const newsletterSelection = input.selectedNewsletterSubscription;
  const subscriptionVisibleMailMessages =
    input.mailboxView === "newsletters" && newsletterSelection
      ? taxonomyVisibleMailMessages.filter(
          (message) =>
            message.account_id === newsletterSelection.accountId &&
            message.newsletter_subscription_id ===
              newsletterSelection.subscriptionId,
        )
      : taxonomyVisibleMailMessages;
  const mailSearchHasAdvancedCriteria = Boolean(
    input.mailSearchStartDate ||
      input.mailSearchEndDate ||
      input.mailSearchSender ||
      input.mailSearchRecipient ||
      input.mailSearchAddress !== "all" ||
      input.mailSearchHasAttachment,
  );
  const mailSearchIsActive =
    input.onlyCodes ||
    input.mailSearchQuery.trim().length > 0 ||
    mailSearchHasAdvancedCriteria ||
    input.mailSearchScope !== "all-mail";
  const searchScopedMailMessages = mailSearchIsActive
    ? applyProjectionSearchScope(visibleMailMessages, input.mailSearchScope)
    : subscriptionVisibleMailMessages;
  const verificationCodesByMessageId = new Map<string, VerificationCodeDto>();
  for (const code of input.recentCodes) {
    verificationCodesByMessageId.set(code.message_id, code);
  }
  for (const message of visibleMailMessages) {
    if (!verificationCodesByMessageId.has(message.message_id)) {
      const inlineCode = detectInlineVerificationCode(message);
      if (inlineCode) {
        verificationCodesByMessageId.set(message.message_id, inlineCode);
      }
    }
  }
  const expandedVerificationCodes = Array.from(verificationCodesByMessageId.values());
  const codeBackedMailMessages: CodeBackedMailMessage[] = searchScopedMailMessages.flatMap(
    (message) => {
      const verificationCode = verificationCodesByMessageId.get(message.message_id);
      return verificationCode ? [{ ...message, verificationCode }] : [];
    },
  );
  const mailSearchAdvancedFilters = {
    query: input.mailSearchQuery,
    fullText: input.mailSearchFullText,
    startDate: input.mailSearchStartDate,
    endDate: input.mailSearchEndDate,
    sender: input.mailSearchSender,
    recipient: input.mailSearchRecipient,
    address: input.mailSearchAddress,
    hasAttachment: input.mailSearchHasAttachment,
  };
  const filteredMailMessages = searchScopedMailMessages.filter((message) =>
    mailSearchMessageMatchesAdvancedFilters(message, mailSearchAdvancedFilters),
  );
  const filteredCodeBackedMailMessages = codeBackedMailMessages.filter((message) => {
    if (!mailSearchMessageMatchesAdvancedFilters(message, mailSearchAdvancedFilters)) {
      return false;
    }
    const query = input.mailSearchQuery.trim().toLowerCase();
    return (
      !query ||
      [
        message.verificationCode.code,
        message.verificationCode.issuer_hint ?? "",
        message.verificationCode.target_service_hint ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query) ||
      visibleMailMessageSearchText(message, input.mailSearchFullText).includes(query)
    );
  });
  const mailListBaseMessages = input.onlyCodes
    ? filteredCodeBackedMailMessages
    : filteredMailMessages;
  const mailListFilteredMessages = mailListBaseMessages.filter((message) => {
    if (input.mailListReadFilter === "unread" && message.is_read) {
      return false;
    }
    if (input.mailListReadFilter === "read" && !message.is_read) {
      return false;
    }
    return !input.mailListHasAttachmentOnly || visibleMailMessageHasAttachment(message);
  });
  const displayedMailMessages = sortMailListMessages(
    mailListFilteredMessages,
    input.mailListSortMode,
  );
  const mailConversationMatchedMessageIds = new Set(
    displayedMailMessages.map((message) => message.message_id),
  );
  const mailConversationSourceMessages = input.onlyCodes
    ? displayedMailMessages
    : sortMailListMessages(searchScopedMailMessages, input.mailListSortMode);
  const displayedMailConversations = buildMailConversations(
    mailConversationSourceMessages,
    verificationCodesByMessageId,
    input.mailListSortMode,
  ).filter((conversation) =>
    conversation.messages.some((message) =>
      mailConversationMatchedMessageIds.has(message.message_id),
    ),
  );
  const displayedMailConversationMessages = displayedMailConversations.flatMap(
    (conversation) => conversation.messages,
  );
  const selectedMailSearchScope =
    [...MAIL_SEARCH_PRIMARY_SCOPES, ...MAIL_SEARCH_OTHER_SCOPES].find(
      (scope) => scope.id === input.mailSearchScope,
    ) ?? MAIL_SEARCH_PRIMARY_SCOPES[0];
  const normalizedMailSearchFolderFilter = input.mailSearchFolderFilter.trim().toLowerCase();
  const filteredMailSearchOtherScopes = normalizedMailSearchFolderFilter
    ? MAIL_SEARCH_OTHER_SCOPES.filter((scope) =>
        `${scope.label} ${scope.id}`.toLowerCase().includes(normalizedMailSearchFolderFilter),
      )
    : MAIL_SEARCH_OTHER_SCOPES;
  const mailSearchAddressOptions = [
    { id: "all", label: "全部" },
    ...input.normalImapAccounts.map((account) => ({
      id: account.primary_address?.toLowerCase() ?? account.id.toLowerCase(),
      label: account.primary_address ?? account.display_name,
    })),
    ...input.promotedAccounts.map((account) => ({
      id: account.primary_address?.toLowerCase() ?? account.id.toLowerCase(),
      label: account.primary_address ?? account.display_name,
    })),
  ];
  const mailSearchResultLabel = input.onlyCodes
    ? `${displayedMailMessages.length} / ${expandedVerificationCodes.length} 条验证码结果 · ${selectedMailSearchScope.label}`
    : input.mailSearchQuery.trim() || mailSearchHasAdvancedCriteria
      ? `${displayedMailMessages.length} 条结果 · ${selectedMailSearchScope.label}`
      : "搜索邮件";
  const displayedMailMessageKey = displayedMailConversationMessages
    .map((message) => message.message_id)
    .join("|");

  return {
    visibleMailMessages,
    mailSearchHasAdvancedCriteria,
    codeBackedMailMessages,
    displayedMailMessages,
    displayedMailConversations,
    displayedMailConversationMessages,
    filteredMailSearchOtherScopes,
    mailSearchAddressOptions,
    mailSearchResultLabel,
    displayedMailMessageKey,
  };
}
