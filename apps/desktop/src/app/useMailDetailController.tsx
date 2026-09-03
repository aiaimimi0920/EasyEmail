import { invoke } from "@tauri-apps/api/core";
import { mailConversationKeyForMessage } from "../mail/mailSelectors";
import { detectInlineVerificationCode, type VerificationCodeDto } from "../mail/mailSearch";
import { useEventCallback } from "../hooks/useEventCallback";
import { asErrorDto } from "./appDomain";
import { bundledCoreClient } from "./appRuntime";
import type { AnonymousMessageDto, MessageDetailDto, VisibleMailMessage, MailConversationSummary } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  invalidateMessageDetailRequest: () => void;
  isCanonicalNormalAccountId: (accountId: string) => boolean;
  loadNewsletterSubscriptions: (accountId: string, isCurrent?: () => boolean) => Promise<import("../api/newsletterClient").NewsletterSubscriptionDto[]>;
  setMessageLocalFlag: (messageId: string, flagName: "starred" | "read" | "archived" | "important", enabled: boolean) => Promise<import("./appTypes").MessageLocalActionDto>;
  reloadMailListsAfterLocalAction: () => Promise<void>;
  loadRecentCodes: (tempMailboxId?: string | null, isCurrent?: () => boolean) => Promise<import("../mail/mailSearch").VerificationCodeDto[]>;
  escapeComposePlainTextToHtml: (text: string) => string;
  restoreComposeDraftSnapshot: (snapshot: import("./appTypes").ComposeDraftSnapshot) => void;
  loadSendQueue: (isCurrent?: () => boolean) => Promise<import("../api/sendQueueClient").SendQueueDto[]>;
  openAvatarEditor: (sender: string, target: HTMLElement) => void;
  closeMailMessageActionMenus: () => void;
};

export function useMailDetailController(appState: AppState, dependencies: Dependencies) {
  const {
    setSelectedMessageDetail, setNormalMessagesByAccount, messageDetailRequestRef, setBusy, coreObservedMessagesRef, tempMailboxes, setStatusMessage, setError,
    composeDraftHydratedRef, selectedNormalAccountId, composePlainTextMode, composeAttachPublicKey, composeRequestReadReceipt, composeExpirationEnabled, composeExternalEncryption, setComposeSchedulePreset,
    setComposeScheduledAtIso, setComposeScheduleCustomValue, setComposeScheduleSendOpen, setComposePopoverOpen, setComposePopoverMinimized, setMailboxView, setSelectedMailMessageId, setSelectedMailConversationKey,
    setComposeDraftDirty, setSelectedMailMessageIds,
  } = appState;
  const {
    invalidateMessageDetailRequest, isCanonicalNormalAccountId, loadNewsletterSubscriptions, setMessageLocalFlag, reloadMailListsAfterLocalAction, loadRecentCodes, escapeComposePlainTextToHtml, restoreComposeDraftSnapshot,
    loadSendQueue, openAvatarEditor, closeMailMessageActionMenus,
  } = dependencies;
  async function loadNormalMessages(
      accountId: string | null,
      isCurrent: () => boolean = () => true,
    ) {
      if (!accountId) {
        invalidateMessageDetailRequest();
        setSelectedMessageDetail(null);
        return [];
      }

      if (isCanonicalNormalAccountId(accountId)) {
        if (isCurrent()) {
          setNormalMessagesByAccount((current) => ({ ...current, [accountId]: [] }));
        }
        return [];
      }

      const [messages] = await Promise.all([
        invoke<AnonymousMessageDto[]>("message_list", {
          request: { scope: "normal_account", account_id: accountId, include_archived: true },
        }),
        loadNewsletterSubscriptions(accountId, isCurrent),
      ]);
      if (!isCurrent()) {
        return messages;
      }
      setNormalMessagesByAccount((current) => ({ ...current, [accountId]: messages }));
      return messages;
    }
  async function loadMessageDetail(messageId: string, markRead = false) {
      const requestId = ++messageDetailRequestRef.current;
      const isCurrent = () => messageDetailRequestRef.current === requestId;
      setBusy(true);
      try {
        const knownCoreMessage = coreObservedMessagesRef.current.get(messageId);
        const coreMessage = knownCoreMessage
          ? (await bundledCoreClient.getObservedMessage(messageId)).message ?? knownCoreMessage
          : undefined;
        const coreMailbox = coreMessage
          ? tempMailboxes.find((mailbox) => mailbox.id === coreMessage.sessionId)
          : undefined;
        let detail: MessageDetailDto = coreMessage
          ? {
              message_id: coreMessage.id,
              account_id: "",
              thread_key: null,
              received_address: coreMailbox?.email_address ?? "",
              subject: coreMessage.subject ?? "(no subject)",
              from_address: coreMessage.sender ?? "",
              snippet: (coreMessage.textBody ?? coreMessage.subject ?? "").slice(0, 240),
              observed_at: coreMessage.observedAt,
              body_text: coreMessage.textBody ?? null,
              body_html: coreMessage.htmlBody ?? null,
              body_cache_state: "available",
              draft_cc_addresses: [],
              draft_bcc_addresses: [],
              is_read: markRead,
              is_starred: false,
              is_archived: false,
              is_important: false,
              local_folder: "inbox",
              labels: [],
            }
          : await invoke<MessageDetailDto>("message_get_detail", {
              request: { message_id: messageId },
            });
        if (!isCurrent()) {
          return;
        }
        if (!coreMessage && markRead && !detail.is_read) {
          await setMessageLocalFlag(messageId, "read", true);
          await reloadMailListsAfterLocalAction();
          if (!isCurrent()) {
            return;
          }
          detail = { ...detail, is_read: true };
        }
        const detailCodeCandidate = detectInlineVerificationCode({
          message_id: detail.message_id,
          temp_mailbox_id: "",
          received_address: detail.received_address,
          provider_label: "",
          subject: detail.subject,
          thread_key: detail.thread_key,
          from_address: detail.from_address,
          snippet: detail.snippet,
          observed_at: detail.observed_at,
          lifecycle_state: "detail",
          is_read: detail.is_read,
          is_starred: detail.is_starred,
          is_archived: detail.is_archived,
          is_important: detail.is_important,
          local_folder: detail.local_folder,
          labels: detail.labels,
          newsletter_subscription_id: null,
          sourceLabel: "",
          sourceId: "",
          body_text: detail.body_text,
          account_id: detail.account_id,
        });
        if (!coreMessage && detailCodeCandidate) {
          try {
            const code = await invoke<VerificationCodeDto | null>("verification_reclassify_message", {
              request: { message_id: messageId },
            });
            if (code && isCurrent()) {
              await loadRecentCodes(null, isCurrent);
            }
          } catch {
            // Opening the message should not fail just because code classification failed.
          }
        }
        if (!isCurrent()) {
          return;
        }
        setSelectedMessageDetail(detail);
        setStatusMessage(`Loaded message detail for ${detail.subject}.`);
        setError(null);
      } catch (caught: unknown) {
        if (isCurrent()) {
          setError(asErrorDto(caught));
        }
      } finally {
        setBusy(false);
      }
    }
  function isPendingScheduledSent(message: VisibleMailMessage) {
      return message.local_folder === "sent" && message.labels.includes("未发送");
    }
  function restoreMessageDetailIntoCompose(
      detail: MessageDetailDto,
      fallbackMessage: VisibleMailMessage,
      status: string,
    ) {
      const bodyText = detail.body_text ?? "";
      const bodyHtml = detail.body_html ?? escapeComposePlainTextToHtml(bodyText);
      composeDraftHydratedRef.current = true;
      restoreComposeDraftSnapshot({
        persistedDraftId: detail.message_id,
        senderAccountId: detail.account_id || selectedNormalAccountId,
        to: detail.received_address || fallbackMessage.received_address,
        cc: detail.draft_cc_addresses.join(", "),
        bcc: detail.draft_bcc_addresses.join(", "),
        recipientDrafts: { to: "", cc: "", bcc: "" },
        subject: detail.subject,
        bodyText,
        bodyHtml,
        plainTextMode: composePlainTextMode,
        attachPublicKey: composeAttachPublicKey,
        requestReadReceipt: composeRequestReadReceipt,
        expirationEnabled: composeExpirationEnabled,
        externalEncryption: composeExternalEncryption,
        scheduledAtIso: null,
        savedAt: detail.observed_at,
      });
      setComposeSchedulePreset(null);
      setComposeScheduledAtIso(null);
      setComposeScheduleCustomValue("");
      setComposeScheduleSendOpen(false);
      setComposePopoverOpen(true);
      setComposePopoverMinimized(false);
      setMailboxView("drafts");
      setSelectedMailMessageId(detail.message_id);
      setSelectedMailConversationKey(mailConversationKeyForMessage(fallbackMessage));
      setSelectedMessageDetail(detail);
      setComposeDraftDirty(false);
      setStatusMessage(status);
      setError(null);
    }
  async function openLocalDraftForEditing(message: VisibleMailMessage) {
      setBusy(true);
      try {
        const detail = await invoke<MessageDetailDto>("message_get_detail", {
          request: { message_id: message.message_id },
        });
        restoreMessageDetailIntoCompose(detail, message, "Draft opened for editing.");
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function openScheduledSendForEditing(message: VisibleMailMessage) {
      setBusy(true);
      try {
        const detail = await invoke<MessageDetailDto>("message_reopen_scheduled_send", {
          request: { message_id: message.message_id },
        });
        const accountId = detail.account_id || selectedNormalAccountId;
        await Promise.all([
          loadSendQueue(),
          accountId ? loadNormalMessages(accountId) : Promise.resolve([]),
        ]);
        restoreMessageDetailIntoCompose(
          detail,
          message,
          "Scheduled send cancelled and opened for editing.",
        );
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  const onCardOpen = useEventCallback((conversation: MailConversationSummary) =>
      openMailConversation(conversation),
    );
  const onCardAvatarClick = useEventCallback((sender: string, target: HTMLElement) =>
      openAvatarEditor(sender, target),
    );
  const onCardToggleSelected = useEventCallback(
      (conversation: MailConversationSummary, isSelected: boolean) => {
        const conversationMessageIds = conversation.messages.map((item) => item.message_id);
        setSelectedMailMessageIds((current) => {
          if (isSelected) {
            return current.filter((messageId) => !conversationMessageIds.includes(messageId));
          }
          const next = new Set(current);
          for (const messageId of conversationMessageIds) {
            next.add(messageId);
          }
          return Array.from(next);
        });
      },
    );
  function openMailConversation(conversation: MailConversationSummary) {
      setSelectedMailConversationKey(conversation.key);
      openMailMessage(conversation.latestMessage);
    }
  function openMailMessage(message: VisibleMailMessage) {
      messageDetailRequestRef.current += 1;
      closeMailMessageActionMenus();
      setSelectedMailConversationKey(mailConversationKeyForMessage(message));
      if (message.local_folder === "drafts") {
        void openLocalDraftForEditing(message);
        return;
      }
      if (isPendingScheduledSent(message)) {
        void openScheduledSendForEditing(message);
        return;
      }
      setSelectedMailMessageId(message.message_id);
      void loadMessageDetail(message.message_id, true);
    }
  return {
    loadNormalMessages, loadMessageDetail, onCardOpen, onCardAvatarClick, onCardToggleSelected, openMailConversation, openMailMessage,
  };
}

export type UseMailDetailControllerResult = ReturnType<typeof useMailDetailController>;
