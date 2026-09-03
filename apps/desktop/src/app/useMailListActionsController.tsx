import type { FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { normalizeMailToken, type MailListSortMode } from "../mail/mailSelectors";
import { asErrorDto } from "./appDomain";
import type { MessageLocalActionDto, MailSearchScope, MailListReadFilter, VisibleMailMessage } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  allVisibleMailMessagesSelected: boolean;
  allVisibleMailMessageIds: string[];
  displayedMailMessages: import("./appTypes").VisibleMailMessage[];
  mailListTotalPages: number;
  mailListActionMessageIds: string[];
  showStatusToast: (message: string) => void;
  reloadMailListsAfterLocalAction: () => Promise<void>;
  invalidateMessageDetailRequest: () => void;
  setMessageLocalFlag: (messageId: string, flagName: "starred" | "read" | "archived" | "important", enabled: boolean) => Promise<import("./appTypes").MessageLocalActionDto>;
  localFolderOptions: import("../api/mailTaxonomyClient").MailTaxonomyItemDto[];
  localLabelOptions: import("../api/mailTaxonomyClient").MailTaxonomyItemDto[];
};

export function useMailListActionsController(appState: AppState, dependencies: Dependencies) {
  const {
    setMailSearchScope, setMailSearchOtherMenuOpen, setMailSearchFolderFilter, setMailSearchQuery, setMailSearchFullText, setMailSearchStartDate, setMailSearchEndDate, setMailSearchSender,
    setMailSearchRecipient, setMailSearchAddress, setMailSearchHasAttachment, setMailSearchOverlayOpen, setMailListReadFilter, setMailListCurrentPage, setMailListFilterMenuOpen, mailListReadFilter,
    setMailListSortMode, setMailListSelectionMenuOpen, setMailListBulkMenuOpen, setMailListMoveMenuOpen, setMailListLabelMenuOpen, setMailListSnoozeMenuOpen, setSelectedMailMessageIds, setBusy,
    setSelectedMessageDetail, setSelectedMailMessageId, setSelectedMailConversationKey, setError, mailListMoveTarget, setMailListMoveTarget, setMailListMoveSearch, setMailListLabelDraftIds,
    selectedMailMessageIds, mailListLabelDraftIds, mailListLabelArchiveAfterApply, setMailListLabelSearch, setMailListLabelArchiveAfterApply,
  } = appState;
  const {
    allVisibleMailMessagesSelected, allVisibleMailMessageIds, displayedMailMessages, mailListTotalPages, mailListActionMessageIds, showStatusToast, reloadMailListsAfterLocalAction, invalidateMessageDetailRequest,
    setMessageLocalFlag, localFolderOptions, localLabelOptions,
  } = dependencies;
  function selectMailSearchScope(scope: MailSearchScope) {
      setMailSearchScope(scope);
      setMailSearchOtherMenuOpen(false);
      setMailSearchFolderFilter("");
    }
  function resetMailSearchOptions() {
      setMailSearchQuery("");
      setMailSearchScope("all-mail");
      setMailSearchFullText(true);
      setMailSearchStartDate("");
      setMailSearchEndDate("");
      setMailSearchSender("");
      setMailSearchRecipient("");
      setMailSearchAddress("all");
      setMailSearchHasAttachment(false);
      setMailSearchOtherMenuOpen(false);
      setMailSearchFolderFilter("");
    }
  function closeMailSearchOverlay() {
      setMailSearchOverlayOpen(false);
      setMailSearchOtherMenuOpen(false);
      setMailSearchFolderFilter("");
    }
  function submitMailSearch(event?: FormEvent) {
      event?.preventDefault();
      closeMailSearchOverlay();
    }
  function setMailListReadFilterAndClose(nextFilter: MailListReadFilter) {
      setMailListReadFilter(nextFilter);
      setMailListCurrentPage(0);
      setMailListFilterMenuOpen(false);
    }
  function toggleMailListUnreadOnly() {
      setMailListReadFilter(mailListReadFilter === "unread" ? "all" : "unread");
      setMailListCurrentPage(0);
      setMailListFilterMenuOpen(false);
    }
  function setMailListSortModeAndClose(nextSortMode: MailListSortMode) {
      setMailListSortMode(nextSortMode);
      setMailListFilterMenuOpen(false);
    }
  function closeMailListToolbarMenus() {
      setMailListSelectionMenuOpen(false);
      setMailListBulkMenuOpen(false);
      setMailListFilterMenuOpen(false);
      setMailListMoveMenuOpen(false);
      setMailListLabelMenuOpen(false);
      setMailListSnoozeMenuOpen(false);
    }
  function toggleMailMessageSelection(messageId: string) {
      setSelectedMailMessageIds((current) =>
        current.includes(messageId)
          ? current.filter((currentId) => currentId !== messageId)
          : [...current, messageId],
      );
    }
  function toggleSelectAllVisibleMailMessages() {
      setSelectedMailMessageIds((current) => {
        if (allVisibleMailMessagesSelected) {
          return current.filter((messageId) => !allVisibleMailMessageIds.includes(messageId));
        }
        return Array.from(new Set([...current, ...allVisibleMailMessageIds]));
      });
    }
  function replaceSelectionFromPredicate(
      predicate: (message: VisibleMailMessage) => boolean,
    ) {
      setSelectedMailMessageIds(displayedMailMessages.filter(predicate).map((message) => message.message_id));
      setMailListSelectionMenuOpen(false);
    }
  function clearMailMessageSelection() {
      setSelectedMailMessageIds([]);
      setMailListSelectionMenuOpen(false);
      setMailListBulkMenuOpen(false);
      setMailListMoveMenuOpen(false);
      setMailListLabelMenuOpen(false);
      setMailListSnoozeMenuOpen(false);
    }
  function goToMailListPage(nextPage: number) {
      setMailListCurrentPage(Math.max(0, Math.min(mailListTotalPages - 1, nextPage)));
    }
  function visibleMessageById(messageId: string) {
      return displayedMailMessages.find((message) => message.message_id === messageId) ?? null;
    }
  async function runBatchMailActions(
      successMessage: string,
      action: (message: VisibleMailMessage) => Promise<unknown>,
    ) {
      const selectedMessages = mailListActionMessageIds
        .map((messageId) => visibleMessageById(messageId))
        .filter((message): message is VisibleMailMessage => message !== null);

      if (selectedMessages.length === 0) {
        showStatusToast("请先选择要处理的邮件。");
        return;
      }

      setBusy(true);
      try {
        await Promise.all(selectedMessages.map((message) => action(message)));
        await reloadMailListsAfterLocalAction();
        invalidateMessageDetailRequest();
        setSelectedMailMessageIds([]);
        setMailListSelectionMenuOpen(false);
        setMailListBulkMenuOpen(false);
        setMailListFilterMenuOpen(false);
        setMailListMoveMenuOpen(false);
        setMailListLabelMenuOpen(false);
        setMailListSnoozeMenuOpen(false);
        setSelectedMessageDetail(null);
        setSelectedMailMessageId(null);
        setSelectedMailConversationKey(null);
        showStatusToast(successMessage.replace("{count}", String(selectedMessages.length)));
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function archiveSelectedMailMessages() {
      await runBatchMailActions("已归档 {count} 封邮件。", (message) =>
        setMessageLocalFlag(message.message_id, "archived", true),
      );
    }
  async function markSelectedMailMessagesRead(enabled: boolean) {
      await runBatchMailActions(enabled ? "已标记 {count} 封邮件为已读。" : "已标记 {count} 封邮件为未读。", (message) =>
        setMessageLocalFlag(message.message_id, "read", enabled),
      );
    }
  async function trashSelectedMailMessages() {
      await runBatchMailActions("已移至回收站 {count} 封邮件。", (message) =>
        invoke<MessageLocalActionDto>("message_delete_local", {
          request: { message_id: message.message_id },
        }),
      );
    }
  async function deleteSelectedMailMessagesForever() {
      await runBatchMailActions("已彻底删除 {count} 封邮件。", (message) =>
        invoke<MessageLocalActionDto>("message_delete_forever", {
          request: { message_id: message.message_id },
        }),
      );
    }
  async function runDisplayedMailActions(
      successMessage: string,
      action: (message: VisibleMailMessage) => Promise<unknown>,
    ) {
      const targetMessages = displayedMailMessages;
      if (targetMessages.length === 0) {
        showStatusToast("当前列表没有可处理的邮件。");
        return;
      }

      setBusy(true);
      try {
        await Promise.all(targetMessages.map((message) => action(message)));
        await reloadMailListsAfterLocalAction();
        invalidateMessageDetailRequest();
        setSelectedMailMessageIds([]);
        setSelectedMessageDetail(null);
        setSelectedMailMessageId(null);
        setSelectedMailConversationKey(null);
        closeMailListToolbarMenus();
        showStatusToast(successMessage.replace("{count}", String(targetMessages.length)));
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function moveAllDisplayedMailMessagesToTrash() {
      await runDisplayedMailActions("已将 {count} 封邮件全部移至回收站。", (message) =>
        invoke<MessageLocalActionDto>("message_delete_local", {
          request: { message_id: message.message_id },
        }),
      );
    }
  async function archiveAllDisplayedMailMessages() {
      await runDisplayedMailActions("已归档 {count} 封邮件。", (message) =>
        setMessageLocalFlag(message.message_id, "archived", true),
      );
    }
  async function moveSelectedMailMessages(folderName: string) {
      await runBatchMailActions(`已将 {count} 封邮件移至 ${folderName}。`, (message) =>
        invoke<MessageLocalActionDto>("message_set_local_folder", {
          request: {
            message_id: message.message_id,
            folder_name: folderName,
          },
        }),
      );
    }
  async function applyMailListMoveTarget() {
      const target = mailListMoveTarget.trim();
      if (!target) {
        showStatusToast("请选择要移动到的文件夹。");
        return;
      }

      if (target.startsWith("folder:")) {
        const folder = localFolderOptions.find((item) => item.id === target.slice("folder:".length));
        if (!folder) {
          showStatusToast("目标文件夹不存在。");
          return;
        }
        await moveSelectedMailMessages(folder.name);
      } else if (target === "trash") {
        await trashSelectedMailMessages();
      } else if (target === "archive") {
        await archiveSelectedMailMessages();
      } else {
        await moveSelectedMailMessages(target);
      }
      setMailListMoveTarget("");
      setMailListMoveSearch("");
    }
  function toggleMailListLabelDraft(labelId: string) {
      setMailListLabelDraftIds((current) =>
        current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId],
      );
    }
  function resetMailListLabelDraftFromSelection() {
      const selectedMessages = selectedMailMessageIds
        .map((messageId) => visibleMessageById(messageId))
        .filter((message): message is VisibleMailMessage => message !== null);

      setMailListLabelDraftIds(
        localLabelOptions
          .filter((label) =>
            selectedMessages.every((message) =>
              message.labels.some((value) => normalizeMailToken(value) === normalizeMailToken(label.name)),
            ),
          )
          .map((label) => label.id),
      );
    }
  async function applyMailListLabelDraft() {
      const selectedMessages = selectedMailMessageIds
        .map((messageId) => visibleMessageById(messageId))
        .filter((message): message is VisibleMailMessage => message !== null);

      if (selectedMessages.length === 0) {
        showStatusToast("请先选择要处理的邮件。");
        return;
      }

      setBusy(true);
      try {
        const operations: Promise<unknown>[] = [];
        localLabelOptions.forEach((label) => {
          const shouldEnable = mailListLabelDraftIds.includes(label.id);
          const enabledForAll = selectedMessages.every((message) =>
            message.labels.some((value) => normalizeMailToken(value) === normalizeMailToken(label.name)),
          );
          if (shouldEnable === enabledForAll) {
            return;
          }
          selectedMessages.forEach((message) => {
            operations.push(
              invoke<MessageLocalActionDto>("message_set_local_label", {
                request: {
                  message_id: message.message_id,
                  label_name: label.name,
                  enabled: shouldEnable,
                },
              }),
            );
          });
        });

        if (mailListLabelArchiveAfterApply) {
          selectedMessages.forEach((message) => {
            operations.push(setMessageLocalFlag(message.message_id, "archived", true));
          });
        }

        if (operations.length === 0) {
          setMailListLabelMenuOpen(false);
          showStatusToast("标签未发生变化。");
          return;
        }

        await Promise.all(operations);
        await reloadMailListsAfterLocalAction();
        invalidateMessageDetailRequest();
        setSelectedMailMessageIds([]);
        setMailListLabelMenuOpen(false);
        setMailListLabelSearch("");
        setMailListLabelArchiveAfterApply(false);
        setSelectedMessageDetail(null);
        setSelectedMailMessageId(null);
        setSelectedMailConversationKey(null);
        showStatusToast(`已更新 ${selectedMessages.length} 封邮件的标签。`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function snoozeSelectedMailMessages(label: string) {
      await runBatchMailActions(`已将 {count} 封邮件推迟到${label}。`, (message) =>
        invoke<MessageLocalActionDto>("message_set_local_folder", {
          request: {
            message_id: message.message_id,
            folder_name: "later",
          },
        }),
      );
    }
  return {
    selectMailSearchScope, resetMailSearchOptions, closeMailSearchOverlay, submitMailSearch, setMailListReadFilterAndClose, toggleMailListUnreadOnly, setMailListSortModeAndClose, closeMailListToolbarMenus,
    toggleMailMessageSelection, toggleSelectAllVisibleMailMessages, replaceSelectionFromPredicate, clearMailMessageSelection, goToMailListPage, archiveSelectedMailMessages, markSelectedMailMessagesRead, trashSelectedMailMessages,
    deleteSelectedMailMessagesForever, moveAllDisplayedMailMessagesToTrash, archiveAllDisplayedMailMessages, moveSelectedMailMessages, applyMailListMoveTarget, toggleMailListLabelDraft, resetMailListLabelDraftFromSelection, applyMailListLabelDraft,
    snoozeSelectedMailMessages,
  };
}

export type UseMailListActionsControllerResult = ReturnType<typeof useMailListActionsController>;
