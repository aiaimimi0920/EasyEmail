import { useEffect, useMemo } from "react";
import { buildMailConversations, filterVisibleMailMessagesForMailbox, normalizeMailToken, sortMailListMessages, sortVisibleMailMessagesByTime, visibleMailMessageHasAttachment } from "../mail/mailSelectors";
import { detectInlineVerificationCode, mailSearchMessageMatchesAdvancedFilters, visibleMailMessageSearchText, type VerificationCodeDto } from "../mail/mailSearch";
import { paginateMailConversations } from "../mail/mailPagination";
import { MAIL_LIST_PAGE_SIZE, MAIL_SEARCH_OTHER_SCOPES, MAIL_SEARCH_PRIMARY_SCOPES } from "./appConfig";
import { applyMailSearchScopeFilter } from "./appDomain";
import type { MailListPrimaryMoveAction, VisibleNewsletterSubscription, VisibleMailMessage, CodeBackedMailMessage } from "./appTypes";
import type { AppState } from "./useAppState";
import type { UseMailSourceControllerResult } from "./useMailSourceController";

type Dependencies = Pick<
  UseMailSourceControllerResult,
  "tempVisibleMessages" | "normalImapAccounts" | "promotedAccounts" | "allVisibleMailMessages"
> & {
  loadMessageDetail: (messageId: string, markRead?: boolean) => Promise<void>;
};

export function useMailProjection(appState: AppState, dependencies: Dependencies) {
  const {
    mailSourceId, normalMessagesByAccount, promotedMessagesByAccount, mailboxView, selectedMailTaxonomyFilter, selectedNewsletterSubscription, mailSearchStartDate, mailSearchEndDate,
    mailSearchSender, mailSearchRecipient, mailSearchAddress, mailSearchHasAttachment, onlyCodes, mailSearchQuery, mailSearchScope, recentCodes,
    mailSearchFullText, mailListReadFilter, mailListHasAttachmentOnly, mailListSortMode, mailSearchFolderFilter, mailListCurrentPage, selectedMailMessageIds, selectedMailMessageId,
    newsletterSubscriptionsByAccount, showHiddenNewsletterSubscriptions, setMailListCurrentPage, setSelectedMailMessageIds, setMailListSelectionMenuOpen, setMailListBulkMenuOpen, setMailListFilterMenuOpen, setMailListMoveMenuOpen,
    setMailListLabelMenuOpen, setMailListSnoozeMenuOpen, setMailListMoveTarget, setMailListLabelDraftIds, selectedMailConversationKey, messageDetailRequestRef, setSelectedMailMessageId, setSelectedMailConversationKey,
    selectedMessageDetail, setSelectedMessageDetail,
  } = appState;
  const {
    tempVisibleMessages, normalImapAccounts, promotedAccounts, allVisibleMailMessages, loadMessageDetail,
  } = dependencies;
  const {
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
    } = useMemo(() => {
      const visibleMailMessages: VisibleMailMessage[] = (() => {
        if (mailSourceId === "temp") {
          return tempVisibleMessages;
        }
        if (mailSourceId.startsWith("account:")) {
          const accountId = mailSourceId.slice("account:".length);
          const account = normalImapAccounts.find((item) => item.id === accountId) ?? null;
          return sortVisibleMailMessagesByTime(
            (normalMessagesByAccount[accountId] ?? []).map((message) => ({
              ...message,
              sourceLabel: account?.display_name ?? "普通邮箱",
              sourceId: `account:${accountId}`,
              account_id: accountId,
            })),
          );
        }
        if (mailSourceId.startsWith("promoted:")) {
          const accountId = mailSourceId.slice("promoted:".length);
          const account = promotedAccounts.find((item) => item.id === accountId) ?? null;
          return sortVisibleMailMessagesByTime(
            (promotedMessagesByAccount[accountId] ?? []).map((message) => ({
              ...message,
              sourceLabel: account?.display_name ?? "临时升级邮箱",
              sourceId: `promoted:${accountId}`,
              account_id: accountId,
            })),
          );
        }
        return allVisibleMailMessages;
      })();

      const mailboxVisibleMailMessages = filterVisibleMailMessagesForMailbox(
        visibleMailMessages,
        mailboxView,
      );
      const taxonomyVisibleMailMessages =
        selectedMailTaxonomyFilter && mailboxView === "folders" && selectedMailTaxonomyFilter.kind === "folder"
          ? mailboxVisibleMailMessages.filter(
              (message) =>
                normalizeMailToken(message.local_folder) ===
                normalizeMailToken(selectedMailTaxonomyFilter.name),
            )
          : selectedMailTaxonomyFilter && mailboxView === "labels" && selectedMailTaxonomyFilter.kind === "label"
            ? mailboxVisibleMailMessages.filter((message) =>
                message.labels.some((label) =>
                  normalizeMailToken(label) === normalizeMailToken(selectedMailTaxonomyFilter.name),
                ),
              )
            : mailboxVisibleMailMessages;
      const subscriptionVisibleMailMessages =
        mailboxView === "newsletters" && selectedNewsletterSubscription
          ? taxonomyVisibleMailMessages.filter(
              (message) =>
                message.account_id === selectedNewsletterSubscription.accountId &&
                message.newsletter_subscription_id === selectedNewsletterSubscription.subscriptionId,
            )
          : taxonomyVisibleMailMessages;
      const mailSearchHasAdvancedCriteria = Boolean(
        mailSearchStartDate ||
          mailSearchEndDate ||
          mailSearchSender ||
          mailSearchRecipient ||
          mailSearchAddress !== "all" ||
          mailSearchHasAttachment,
      );
      const mailSearchIsActive =
        onlyCodes ||
        mailSearchQuery.trim().length > 0 ||
        mailSearchHasAdvancedCriteria ||
        mailSearchScope !== "all-mail";
      const mailSearchBaseMessages = mailSearchIsActive
        ? visibleMailMessages
        : subscriptionVisibleMailMessages;
      const searchScopedMailMessages = mailSearchIsActive
        ? applyMailSearchScopeFilter(mailSearchBaseMessages, mailSearchScope)
        : subscriptionVisibleMailMessages;
      const verificationCodesByMessageId = new Map<string, VerificationCodeDto>();
      for (const code of recentCodes) {
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
        query: mailSearchQuery,
        fullText: mailSearchFullText,
        startDate: mailSearchStartDate,
        endDate: mailSearchEndDate,
        sender: mailSearchSender,
        recipient: mailSearchRecipient,
        address: mailSearchAddress,
        hasAttachment: mailSearchHasAttachment,
      };
      const filteredMailMessages = searchScopedMailMessages.filter((message) =>
        mailSearchMessageMatchesAdvancedFilters(message, mailSearchAdvancedFilters),
      );
      const filteredCodeBackedMailMessages = codeBackedMailMessages.filter((message) => {
        if (!mailSearchMessageMatchesAdvancedFilters(message, mailSearchAdvancedFilters)) {
          return false;
        }
        const query = mailSearchQuery.trim().toLowerCase();
        if (!query) {
          return true;
        }
        return [
          message.verificationCode.code,
          message.verificationCode.issuer_hint ?? "",
          message.verificationCode.target_service_hint ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(query) ||
          visibleMailMessageSearchText(message, mailSearchFullText).includes(query);
      });
      const mailListBaseMessages = onlyCodes
        ? filteredCodeBackedMailMessages
        : filteredMailMessages;
      const mailListFilteredMessages = mailListBaseMessages.filter((message) => {
        if (mailListReadFilter === "unread" && message.is_read) {
          return false;
        }
        if (mailListReadFilter === "read" && !message.is_read) {
          return false;
        }
        if (mailListHasAttachmentOnly && !visibleMailMessageHasAttachment(message)) {
          return false;
        }
        return true;
      });
      const displayedMailMessages = sortMailListMessages(
        mailListFilteredMessages,
        mailListSortMode,
      );
      const mailConversationMatchedMessageIds = new Set(
        displayedMailMessages.map((message) => message.message_id),
      );
      const mailConversationSourceMessages = onlyCodes
        ? displayedMailMessages
        : sortMailListMessages(searchScopedMailMessages, mailListSortMode);
      const displayedMailConversations = buildMailConversations(
        mailConversationSourceMessages,
        verificationCodesByMessageId,
        mailListSortMode,
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
          (scope) => scope.id === mailSearchScope,
        ) ?? MAIL_SEARCH_PRIMARY_SCOPES[0];
      const normalizedMailSearchFolderFilter = mailSearchFolderFilter.trim().toLowerCase();
      const filteredMailSearchOtherScopes = normalizedMailSearchFolderFilter
        ? MAIL_SEARCH_OTHER_SCOPES.filter((scope) =>
            `${scope.label} ${scope.id}`.toLowerCase().includes(normalizedMailSearchFolderFilter),
          )
        : MAIL_SEARCH_OTHER_SCOPES;
      const mailSearchAddressOptions = [
        { id: "all", label: "全部" },
        ...normalImapAccounts.map((account) => ({
          id: account.primary_address?.toLowerCase() ?? account.id.toLowerCase(),
          label: account.primary_address ?? account.display_name,
        })),
        ...promotedAccounts.map((account) => ({
          id: account.primary_address?.toLowerCase() ?? account.id.toLowerCase(),
          label: account.primary_address ?? account.display_name,
        })),
      ];
      const mailSearchResultLabel = onlyCodes
        ? `${displayedMailMessages.length} / ${expandedVerificationCodes.length} 条验证码结果 · ${selectedMailSearchScope.label}`
        : mailSearchQuery.trim() || mailSearchHasAdvancedCriteria
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
    }, [
      allVisibleMailMessages,
      mailListHasAttachmentOnly,
      mailListReadFilter,
      mailListSortMode,
      mailSearchAddress,
      mailSearchEndDate,
      mailSearchFolderFilter,
      mailSearchFullText,
      mailSearchHasAttachment,
      mailSearchQuery,
      mailSearchRecipient,
      mailSearchScope,
      mailSearchSender,
      mailSearchStartDate,
      mailboxView,
      mailSourceId,
      normalImapAccounts,
      normalMessagesByAccount,
      onlyCodes,
      promotedAccounts,
      promotedMessagesByAccount,
      recentCodes,
      selectedMailTaxonomyFilter,
      selectedNewsletterSubscription,
      tempVisibleMessages,
    ]);
  const {
      mailListTotalPages,
      clampedMailListCurrentPage,
      mailListPageStart,
      mailListPageEnd,
      paginatedDisplayedMailConversations,
      paginatedDisplayedMailMessages,
    } = useMemo(
      () =>
        paginateMailConversations(displayedMailConversations, mailListCurrentPage, MAIL_LIST_PAGE_SIZE),
      [displayedMailConversations, mailListCurrentPage],
    );
  const paginatedCodeBackedMailMessages =
      paginatedDisplayedMailMessages as CodeBackedMailMessage[];
  const {
      selectedMailMessageIdsSet,
      mailListActionMessageIds,
      mailListHasSelection,
      selectedMailMessagesHaveUnread,
      mailListPrimaryMoveActions,
      allVisibleMailMessageIds,
      allVisibleMailMessagesSelected,
      someVisibleMailMessagesSelected,
    } = useMemo(() => {
      const selectedMailMessageIdsSet = new Set(selectedMailMessageIds);
      const mailListCheckedSelection = selectedMailMessageIds.length > 0;
      const mailListActionMessageIds = mailListCheckedSelection
        ? selectedMailMessageIds
        : selectedMailMessageId
          ? [selectedMailMessageId]
          : [];
      const selectedMailMessagesForActions = mailListActionMessageIds
        .map(
          (messageId) =>
            displayedMailMessages.find((message) => message.message_id === messageId) ?? null,
        )
        .filter((message): message is VisibleMailMessage => message !== null);
      const mailListHasSelection = mailListCheckedSelection;
      const selectedMailMessagesHaveUnread = selectedMailMessagesForActions.some(
        (message) => !message.is_read,
      );
      const mailListPrimaryMoveActions: MailListPrimaryMoveAction[] = (() => {
        switch (mailboxView) {
          case "archive":
            return ["trash", "inbox", "spam"];
          case "spam":
            return ["trash", "nospam", "delete"];
          case "trash":
            return ["inbox", "archive", "delete"];
          case "drafts":
          case "sent":
            return ["trash", "archive", "delete"];
          default:
            return ["trash", "archive", "spam"];
        }
      })();
      const allVisibleMailMessageIds = paginatedDisplayedMailMessages.map(
        (message) => message.message_id,
      );
      const allVisibleMailMessagesSelected =
        allVisibleMailMessageIds.length > 0 &&
        allVisibleMailMessageIds.every((messageId) =>
          selectedMailMessageIdsSet.has(messageId),
        );
      const someVisibleMailMessagesSelected =
        allVisibleMailMessageIds.some((messageId) =>
          selectedMailMessageIdsSet.has(messageId),
        ) && !allVisibleMailMessagesSelected;

      return {
        selectedMailMessageIdsSet,
        mailListActionMessageIds,
        mailListHasSelection,
        selectedMailMessagesHaveUnread,
        mailListPrimaryMoveActions,
        allVisibleMailMessageIds,
        allVisibleMailMessagesSelected,
        someVisibleMailMessagesSelected,
      };
    }, [
      displayedMailMessages,
      mailboxView,
      paginatedDisplayedMailMessages,
      selectedMailMessageId,
      selectedMailMessageIds,
    ]);
  const {
      displayedNewsletterSubscriptions,
      hiddenNewsletterSubscriptionCount,
    } = useMemo(() => {
      const allDisplayedNewsletterSubscriptions: VisibleNewsletterSubscription[] =
        mailboxView === "newsletters"
          ? mailSourceId.startsWith("account:")
            ? (newsletterSubscriptionsByAccount[mailSourceId.slice("account:".length)] ?? []).map(
                (subscription) => ({
                  ...subscription,
                  account_id: mailSourceId.slice("account:".length),
                }),
              )
            : normalImapAccounts.flatMap(
                (account) =>
                  (newsletterSubscriptionsByAccount[account.id] ?? []).map((subscription) => ({
                    ...subscription,
                    account_id: account.id,
                  })),
              )
          : [];

      return {
        displayedNewsletterSubscriptions: allDisplayedNewsletterSubscriptions.filter(
          (subscription) => showHiddenNewsletterSubscriptions || !subscription.hidden,
        ),
        hiddenNewsletterSubscriptionCount: allDisplayedNewsletterSubscriptions.filter(
          (subscription) => subscription.hidden,
        ).length,
      };
    }, [
      mailSourceId,
      mailboxView,
      newsletterSubscriptionsByAccount,
      normalImapAccounts,
      showHiddenNewsletterSubscriptions,
    ]);
  useEffect(() => {
      if (mailListCurrentPage !== clampedMailListCurrentPage) {
        setMailListCurrentPage(clampedMailListCurrentPage);
      }
    }, [clampedMailListCurrentPage, mailListCurrentPage]);
  useEffect(() => {
      setSelectedMailMessageIds((current) =>
        current.filter((messageId) =>
          displayedMailConversationMessages.some((message) => message.message_id === messageId),
        ),
      );
    }, [displayedMailMessageKey, displayedMailConversationMessages]);
  useEffect(() => {
      setMailListCurrentPage(0);
    }, [mailSourceId, mailboxView, onlyCodes, mailSearchQuery, mailSearchScope, mailSearchStartDate, mailSearchEndDate, mailSearchSender, mailSearchRecipient, mailSearchAddress, mailSearchHasAttachment, mailListReadFilter, mailListHasAttachmentOnly, mailListSortMode, selectedMailTaxonomyFilter, selectedNewsletterSubscription]);
  useEffect(() => {
      setMailListSelectionMenuOpen(false);
      setMailListBulkMenuOpen(false);
      setMailListFilterMenuOpen(false);
      setMailListMoveMenuOpen(false);
      setMailListLabelMenuOpen(false);
      setMailListSnoozeMenuOpen(false);
      setMailListMoveTarget("");
      setMailListLabelDraftIds([]);
    }, [mailSourceId, mailboxView, selectedMailTaxonomyFilter, selectedNewsletterSubscription]);
  useEffect(() => {
      const selectedIsVisible =
        selectedMailConversationKey !== null
          ? paginatedDisplayedMailConversations.some(
              (conversation) => conversation.key === selectedMailConversationKey,
            )
          : selectedMailMessageId !== null &&
            paginatedDisplayedMailConversations.some((conversation) =>
              conversation.messages.some((message) => message.message_id === selectedMailMessageId),
            );

      if (selectedIsVisible) {
        return;
      }

      const nextConversation = paginatedDisplayedMailConversations[0] ?? null;
      if (!nextConversation) {
        messageDetailRequestRef.current += 1;
        if (selectedMailMessageId !== null) {
          setSelectedMailMessageId(null);
        }
        if (selectedMailConversationKey !== null) {
          setSelectedMailConversationKey(null);
        }
        if (selectedMessageDetail !== null) {
          setSelectedMessageDetail(null);
        }
        return;
      }

      setSelectedMailConversationKey(nextConversation.key);
      setSelectedMailMessageId(nextConversation.latestMessage.message_id);
      void loadMessageDetail(nextConversation.latestMessage.message_id);
    }, [
      displayedMailMessageKey,
      paginatedDisplayedMailConversations,
      selectedMailConversationKey,
      selectedMailMessageId,
      selectedMessageDetail,
    ]);
  return {
    visibleMailMessages, mailSearchHasAdvancedCriteria, codeBackedMailMessages, displayedMailMessages, displayedMailConversations, filteredMailSearchOtherScopes, mailSearchAddressOptions, mailSearchResultLabel,
    mailListTotalPages, clampedMailListCurrentPage, mailListPageStart, mailListPageEnd, paginatedDisplayedMailConversations, paginatedDisplayedMailMessages, paginatedCodeBackedMailMessages, selectedMailMessageIdsSet,
    mailListActionMessageIds, mailListHasSelection, selectedMailMessagesHaveUnread, mailListPrimaryMoveActions, allVisibleMailMessageIds, allVisibleMailMessagesSelected, someVisibleMailMessagesSelected, displayedNewsletterSubscriptions,
    hiddenNewsletterSubscriptionCount,
  };
}

export type UseMailProjectionResult = ReturnType<typeof useMailProjection>;
