import { useEffect, useMemo } from "react";
import { paginateMailConversations } from "../mail/mailPagination";
import { MAIL_LIST_PAGE_SIZE } from "./appConfig";
import { deriveMailProjection } from "./mailProjection";
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
    } = useMemo(
      () =>
        deriveMailProjection({
          mailSourceId,
          normalMessagesByAccount,
          promotedMessagesByAccount,
          mailboxView,
          selectedMailTaxonomyFilter,
          selectedNewsletterSubscription,
          mailSearchStartDate,
          mailSearchEndDate,
          mailSearchSender,
          mailSearchRecipient,
          mailSearchAddress,
          mailSearchHasAttachment,
          onlyCodes,
          mailSearchQuery,
          mailSearchScope,
          recentCodes,
          mailSearchFullText,
          mailListReadFilter,
          mailListHasAttachmentOnly,
          mailListSortMode,
          mailSearchFolderFilter,
          tempVisibleMessages,
          normalImapAccounts,
          promotedAccounts,
          allVisibleMailMessages,
        }),
      [
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
