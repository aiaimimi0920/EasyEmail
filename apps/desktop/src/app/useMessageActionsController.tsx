import { invoke } from "@tauri-apps/api/core";
import { extractEmailAddress, filterVisibleMailMessagesForMailbox, mailConversationKeyForMessage, normalizeMailToken } from "../mail/mailSelectors";
import { asErrorDto } from "./appDomain";
import type {
  AnonymousMessageDto,
  MailConversationSummary,
  MessageBatchActionDto,
  MessageCache,
  MessageLocalActionDto,
} from "./appTypes";
import type { AppState } from "./useAppState";
import type { UseDeliveryAgentControllerResult } from "./useDeliveryAgentController";
import type { UseMailProjectionResult } from "./useMailProjection";
import type { UseMailSourceControllerResult } from "./useMailSourceController";
import type { UseSelectedMailViewResult } from "./useSelectedMailView";

type Dependencies = Pick<
  UseSelectedMailViewResult,
  "selectedVisibleMailMessage" | "selectedMailMessage" | "selectedMailMessageIndex"
> &
  Pick<UseMailSourceControllerResult, "normalImapAccounts" | "promotedAccounts"> &
  Pick<
    UseMailProjectionResult,
    "paginatedDisplayedMailConversations" | "visibleMailMessages"
  > &
  Pick<UseDeliveryAgentControllerResult, "loadPromotedMessages"> & {
  setDraftBodyText: (text: string) => void;
  openMailConversation: (conversation: MailConversationSummary) => void;
  loadAnonymousMessages: () => Promise<AnonymousMessageDto[]>;
  loadNormalMessages: (
    accountId: string | null,
    isCurrent?: () => boolean,
  ) => Promise<AnonymousMessageDto[]>;
  loadRecentCodes: (tempMailboxId?: string | null, isCurrent?: () => boolean) => Promise<unknown[]>;
  invalidateMessageDetailRequest: () => void;
  loadMessageDetail: (messageId: string, markRead?: boolean) => Promise<void>;
  closeMailMessageActionMenus: () => void;
};

export function useMessageActionsController(appState: AppState, dependencies: Dependencies) {
  const {
    setError, setSelectedNormalAccountId, setSendTargetAddress, setSendSubject, setComposePopoverOpen, setStatusMessage, mailSourceId, setBusy,
    setSelectedMessageDetail, setSelectedMailMessageId, setSelectedMailConversationKey, setAnonymousMessages, setNormalMessagesByAccount, setPromotedMessagesByAccount,
  } = appState;
  const {
    selectedVisibleMailMessage, selectedMailMessage, normalImapAccounts, setDraftBodyText, selectedMailMessageIndex, paginatedDisplayedMailConversations, openMailConversation, loadAnonymousMessages,
    loadNormalMessages, promotedAccounts, loadPromotedMessages, loadRecentCodes, invalidateMessageDetailRequest, loadMessageDetail, visibleMailMessages, closeMailMessageActionMenus,
  } = dependencies;
  function draftReplyToMail() {
      if (!selectedVisibleMailMessage || !selectedMailMessage) {
        return;
      }

      const realAccountId = selectedVisibleMailMessage.sourceId.startsWith("account:")
        ? selectedVisibleMailMessage.sourceId.slice("account:".length)
        : null;
      if (!realAccountId) {
        setError({
          code: "reply_source_unsupported",
          user_message: "Only long-lived mail accounts can draft replies.",
          correlation_id: "local-validation",
        });
        return;
      }

      const replyAccount = normalImapAccounts.find((account) => account.id === realAccountId) ?? null;
      setSelectedNormalAccountId(realAccountId);

      const subject = selectedMailMessage.subject.trim();
      const originalBody =
        "body_text" in selectedMailMessage
          ? selectedMailMessage.body_text ?? selectedMailMessage.snippet
          : selectedMailMessage.snippet;
      const originalRecipient =
        selectedMailMessage.received_address || replyAccount?.primary_address || realAccountId;

      setSendTargetAddress(extractEmailAddress(selectedMailMessage.from_address));
      setSendSubject(/^re:/i.test(subject) ? subject : `Re: ${subject}`);
      setDraftBodyText(
        [
          "",
          "",
          "--- Original message ---",
          `From: ${selectedMailMessage.from_address}`,
          `To: ${originalRecipient}`,
          `Observed: ${selectedMailMessage.observed_at}`,
          "",
          originalBody,
        ].join("\n"),
      );
      setComposePopoverOpen(true);
      setStatusMessage(
        `Drafted reply from ${replyAccount?.display_name ?? "selected mailbox"}.`,
      );
      setError(null);
    }
  function draftReplyAllToMail() {
      draftReplyToMail();
      if (selectedMailMessage) {
        setStatusMessage("Drafted reply-all using the selected sender account.");
      }
    }
  function draftForwardMail() {
      if (!selectedVisibleMailMessage || !selectedMailMessage) {
        return;
      }

      const realAccountId = selectedVisibleMailMessage.sourceId.startsWith("account:")
        ? selectedVisibleMailMessage.sourceId.slice("account:".length)
        : null;
      if (!realAccountId) {
        setError({
          code: "forward_source_unsupported",
          user_message: "Only long-lived mail accounts can draft forwarded mail.",
          correlation_id: "local-validation",
        });
        return;
      }

      const subject = selectedMailMessage.subject.trim();
      const originalBody =
        "body_text" in selectedMailMessage
          ? selectedMailMessage.body_text ?? selectedMailMessage.snippet
          : selectedMailMessage.snippet;
      const originalRecipient =
        selectedVisibleMailMessage.received_address || selectedMailMessage.received_address || realAccountId;

      setSelectedNormalAccountId(realAccountId);
      setSendTargetAddress("");
      setSendSubject(/^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`);
      setDraftBodyText(
        [
          "",
          "",
          "--- Forwarded message ---",
          `From: ${selectedMailMessage.from_address}`,
          `To: ${originalRecipient}`,
          `Observed: ${selectedMailMessage.observed_at}`,
          "",
          originalBody,
        ].join("\n"),
      );
      setComposePopoverOpen(true);
      setStatusMessage("Drafted forward from the selected mailbox.");
      setError(null);
    }
  function openAdjacentMailMessage(direction: -1 | 1) {
      if (selectedMailMessageIndex < 0) {
        return;
      }
      const adjacentConversation =
        paginatedDisplayedMailConversations[selectedMailMessageIndex + direction] ?? null;
      if (!adjacentConversation) {
        return;
      }
      openMailConversation(adjacentConversation);
    }
  function nextMessageAfterLocalAction() {
      if (selectedMailMessageIndex < 0) {
        return null;
      }
      return (
        paginatedDisplayedMailConversations[selectedMailMessageIndex + 1]?.latestMessage ??
        paginatedDisplayedMailConversations[selectedMailMessageIndex - 1]?.latestMessage ??
        null
      );
    }
  async function reloadMailListsAfterLocalAction() {
      if (mailSourceId === "all") {
        await Promise.all([
          loadAnonymousMessages(),
          ...normalImapAccounts.map((account) => loadNormalMessages(account.id)),
          ...promotedAccounts.map((account) => loadPromotedMessages(account.id)),
        ]);
      } else if (mailSourceId === "temp") {
        await loadAnonymousMessages();
      } else if (mailSourceId.startsWith("account:")) {
        await loadNormalMessages(mailSourceId.slice("account:".length));
      } else if (mailSourceId.startsWith("promoted:")) {
        await loadPromotedMessages(mailSourceId.slice("promoted:".length));
      }
      await loadRecentCodes();
    }
  async function runSelectedMessageLocalAction(
      successMessage: string,
      action: () => Promise<MessageLocalActionDto>,
    ) {
      if (!selectedMailMessage) {
        return;
      }

      const fallbackMessage = nextMessageAfterLocalAction();
      setBusy(true);
      try {
        await action();
        await reloadMailListsAfterLocalAction();
        invalidateMessageDetailRequest();
        setSelectedMessageDetail(null);
        if (fallbackMessage) {
          setSelectedMailMessageId(fallbackMessage.message_id);
          setSelectedMailConversationKey(mailConversationKeyForMessage(fallbackMessage));
          void loadMessageDetail(fallbackMessage.message_id);
        } else {
          setSelectedMailMessageId(null);
          setSelectedMailConversationKey(null);
        }
        setStatusMessage(successMessage);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function deleteSelectedMailMessage() {
      if (!selectedMailMessage) {
        return;
      }

      await runSelectedMessageLocalAction("Moved the message to Trash.", () =>
        invoke<MessageLocalActionDto>("message_delete_local", {
          request: { message_id: selectedMailMessage.message_id },
        }),
      );
    }
  async function deleteSelectedMailMessageForever() {
      if (!selectedMailMessage) {
        return;
      }

      await runSelectedMessageLocalAction("Permanently deleted the message.", () =>
        invoke<MessageLocalActionDto>("message_delete_forever", {
          request: { message_id: selectedMailMessage.message_id },
        }),
      );
    }
  async function restoreSelectedMailMessage() {
      await moveSelectedMailMessage("inbox");
    }
  async function emptyCurrentTrash() {
      const trashMessages = filterVisibleMailMessagesForMailbox(visibleMailMessages, "trash");
      if (trashMessages.length === 0) {
        setStatusMessage("Trash is already empty.");
        return;
      }

      setBusy(true);
      try {
        const result = await invoke<MessageBatchActionDto>("message_empty_trash", {
          request: { message_ids: trashMessages.map((message) => message.message_id) },
        });
        await reloadMailListsAfterLocalAction();
        invalidateMessageDetailRequest();
        setSelectedMailMessageId(null);
        setSelectedMailConversationKey(null);
        setSelectedMessageDetail(null);
        setStatusMessage(
          `Emptied Trash: ${result.changed_count}/${result.requested_count} messages removed.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function setMessageLocalFlag(
      messageId: string,
      flagName: "archived" | "read" | "starred" | "important",
      enabled: boolean,
    ) {
      return invoke<MessageLocalActionDto>("message_set_local_flag", {
        request: {
          message_id: messageId,
          flag_name: flagName,
          enabled,
        },
      });
    }
  function updateCachedVisibleMailMessageLocalFlag(
      messageId: string,
      flagName: "archived" | "read" | "starred" | "important",
      enabled: boolean,
    ) {
      const updateMessage = (message: AnonymousMessageDto): AnonymousMessageDto =>
        message.message_id === messageId
          ? {
              ...message,
              is_read: flagName === "read" ? enabled : message.is_read,
              is_starred: flagName === "starred" ? enabled : message.is_starred,
              is_archived: flagName === "archived" ? enabled : message.is_archived,
              is_important: flagName === "important" ? enabled : message.is_important,
            }
          : message;
      const updateCache = (cache: MessageCache): MessageCache =>
        Object.fromEntries(
          Object.entries(cache).map(([accountId, messages]) => [
            accountId,
            messages.map(updateMessage),
          ]),
        );

      setAnonymousMessages((current) => current.map(updateMessage));
      setNormalMessagesByAccount((current) => updateCache(current));
      setPromotedMessagesByAccount((current) => updateCache(current));
    }
  async function setSelectedMailFlag(
      flagName: "archived" | "read" | "starred" | "important",
      enabled: boolean,
    ) {
      if (!selectedMailMessage) {
        return;
      }

      await setMessageLocalFlag(selectedMailMessage.message_id, flagName, enabled);
      updateCachedVisibleMailMessageLocalFlag(selectedMailMessage.message_id, flagName, enabled);
      setSelectedMessageDetail((current) =>
        current?.message_id === selectedMailMessage.message_id
          ? {
              ...current,
              is_read: flagName === "read" ? enabled : current.is_read,
              is_starred: flagName === "starred" ? enabled : current.is_starred,
              is_archived: flagName === "archived" ? enabled : current.is_archived,
              is_important: flagName === "important" ? enabled : current.is_important,
            }
          : current,
      );
    }
  async function toggleSelectedMailStarred() {
      if (!selectedMailMessage) {
        return;
      }

      const enabled = !selectedMailMessage.is_starred;
      setBusy(true);
      try {
        await setSelectedMailFlag("starred", enabled);
        setStatusMessage(enabled ? "已加入星标邮件。" : "已取消星标邮件。");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function archiveSelectedMailMessage() {
      await runSelectedMessageLocalAction("Archived the message.", async () => {
        if (!selectedMailMessage) {
          return { message_id: "", changed: false, status: "unchanged", remote_applied: false };
        }
        return setMessageLocalFlag(selectedMailMessage.message_id, "archived", true);
      });
    }
  async function markSelectedMailMessageRead(enabled = true) {
      if (!selectedMailMessage) {
        return;
      }

      setBusy(true);
      try {
        await setSelectedMailFlag("read", enabled);
        await reloadMailListsAfterLocalAction();
        setStatusMessage(enabled ? "Marked the message as read." : "Marked the message as unread.");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function moveSelectedMailMessage(folderName: string) {
      if (!selectedMailMessage) {
        return;
      }

      setBusy(true);
      try {
        await invoke<MessageLocalActionDto>("message_set_local_folder", {
          request: {
            message_id: selectedMailMessage.message_id,
            folder_name: folderName,
          },
        });
        setSelectedMessageDetail((current) =>
          current?.message_id === selectedMailMessage.message_id
            ? {
                ...current,
                local_folder: normalizeMailToken(folderName),
                is_archived: normalizeMailToken(folderName) === "archive",
              }
            : current,
        );
        await reloadMailListsAfterLocalAction();
        closeMailMessageActionMenus();
        setStatusMessage(`Moved the message to ${folderName}.`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function labelSelectedMailMessage(labelName: string, enabled: boolean) {
      if (!selectedMailMessage) {
        return;
      }

      setBusy(true);
      try {
        await invoke<MessageLocalActionDto>("message_set_local_label", {
          request: {
            message_id: selectedMailMessage.message_id,
            label_name: labelName,
            enabled,
          },
        });
        setSelectedMessageDetail((current) => {
          if (current?.message_id !== selectedMailMessage.message_id) {
            return current;
          }
          const labels = enabled
            ? Array.from(new Set([...current.labels, labelName])).sort()
            : current.labels.filter((label) => label !== labelName);
          return { ...current, labels };
        });
        await reloadMailListsAfterLocalAction();
        setStatusMessage(enabled ? `Added label ${labelName}.` : `Removed label ${labelName}.`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  return {
    draftReplyToMail, draftReplyAllToMail, draftForwardMail, openAdjacentMailMessage, reloadMailListsAfterLocalAction, deleteSelectedMailMessage, deleteSelectedMailMessageForever, restoreSelectedMailMessage,
    emptyCurrentTrash, setMessageLocalFlag, setSelectedMailFlag, toggleSelectedMailStarred, archiveSelectedMailMessage, markSelectedMailMessageRead, moveSelectedMailMessage, labelSelectedMailMessage,
  };
}

export type UseMessageActionsControllerResult = ReturnType<typeof useMessageActionsController>;
