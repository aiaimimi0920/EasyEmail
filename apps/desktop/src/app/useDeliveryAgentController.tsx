import { invoke } from "@tauri-apps/api/core";
import { joinComposeAddressList } from "../compose/composeData";
import { formatComposeScheduleDate } from "../compose/composeDateUtils";
import { COMPOSE_DRAFT_STORAGE_KEY } from "./appConfig";
import { asErrorDto, optionalValue } from "./appDomain";
import { sendQueueClient } from "./appRuntime";
import type { LegacyAccountDto, SendMessageDto, AgentServiceDto, AgentThreadDetailDto, AgentSendTaskDto, AnonymousMessageDto, MessageLocalActionDto } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  isCanonicalNormalAccountId: (accountId: string) => boolean;
  composeRecipientsForSend: (field: import("../compose/composeData").ComposeRecipientField) => string[];
  composeRichBodyHtmlToPlainText: (editor: HTMLElement) => string;
  showStatusToast: (message: string) => void;
  loadSendQueue: (isCurrent?: () => boolean) => Promise<import("../api/sendQueueClient").SendQueueDto[]>;
  loadNormalMessages: (accountId: string, isCurrent?: () => boolean) => Promise<import("./appTypes").AnonymousMessageDto[]>;
  setDraftBodyText: (text: string) => void;
  loadAgentAccounts: () => Promise<import("./appTypes").LegacyAccountDto[]>;
  loadAgentServices: () => Promise<import("./appTypes").AgentServiceDto[]>;
  loadAgentThreads: () => Promise<import("./appTypes").AgentThreadDto[]>;
};

export function useDeliveryAgentController(appState: AppState, dependencies: Dependencies) {
  const {
    selectedNormalAccountId, setError, setBusy, composePersistedDraftId, composeScheduledAtIso, composeBodyEditorRef, sendBodyText, setSendBodyHtml,
    setSendBodyText, sendSubject, setLastSend, setLastSendWorkerRun, setStatusMessage, setSendTargetAddress, setComposeCcAddress, setComposeBccAddress,
    setComposeRecipientDrafts, setComposeCcOpen, setComposeBccOpen, setComposeContactPickerField, setComposeRecipientMenu, setSendSubject, setComposeSchedulePreset, setComposeScheduledAtIso,
    setComposeDraftDirty, setComposeDraftSavedAt, composeDraftRevisionRef, composePersistedDraftIdRef, setComposePersistedDraftId, agentDisplayName, agentEmailAddress, setSelectedAgentSenderId,
    setAgentEmailAddress, agentServiceName, agentServiceEmail, agentServiceDescription, agentTrustLevel, selectedAgentSenderId, setSelectedAgentServiceId, setAgentServiceEmail,
    setAgentServiceDescription, selectedAgentServiceId, agentTaskSubject, agentTaskBody, confirmRestrictedAgent, setLastAgentTask, setAgentTaskSubject, setAgentTaskBody,
    setSelectedAgentThreadDetail, setPromotedMessagesByAccount,
  } = appState;
  const {
    isCanonicalNormalAccountId, composeRecipientsForSend, composeRichBodyHtmlToPlainText, showStatusToast, loadSendQueue, loadNormalMessages, setDraftBodyText, loadAgentAccounts,
    loadAgentServices, loadAgentThreads,
  } = dependencies;
  async function enqueueDraftSend() {
      if (!selectedNormalAccountId) {
        setError({
          code: "sender_required",
          user_message: "Select a send-enabled normal account before sending mail.",
          correlation_id: "local-validation",
        });
        return false;
      }
      if (selectedNormalAccountId !== null && isCanonicalNormalAccountId(selectedNormalAccountId)) {
        setError({
          code: "canonical_smtp_unavailable",
          user_message: "Sending from canonical accounts becomes available in M5.",
          correlation_id: "desktop-migration-boundary",
        });
        return false;
      }

      setBusy(true);
      try {
        const senderAccountId = selectedNormalAccountId;
        const persistedDraftId = composePersistedDraftId;
        const scheduledAt = composeScheduledAtIso;
        const targetAddresses = joinComposeAddressList(composeRecipientsForSend("to"));
        const editor = composeBodyEditorRef.current;
        const bodyText = editor ? composeRichBodyHtmlToPlainText(editor) : sendBodyText;
        if (editor) {
          setSendBodyHtml(editor.innerHTML);
          setSendBodyText(bodyText);
        }
        const result = await invoke<SendMessageDto>("send_message", {
          request: {
            account_id: senderAccountId,
            target_address: targetAddresses,
            cc_addresses: composeRecipientsForSend("cc"),
            bcc_addresses: composeRecipientsForSend("bcc"),
            scheduled_at: scheduledAt,
            subject: sendSubject,
            body_text: bodyText,
          },
        });
        setLastSend(result);

        if (!scheduledAt) {
          showStatusToast("正在通过 SMTP 发送邮件...");
          const queueItem = await sendQueueClient.runSendQueueItem({
            queue_id: result.queue_id,
          });
          setLastSendWorkerRun({
            processed_count: queueItem.status === "queued" ? 0 : 1,
            sent_count: queueItem.status === "sent" ? 1 : 0,
            retry_count: queueItem.status === "queued" ? 1 : 0,
            failed_count: queueItem.status === "failed" || queueItem.status === "auth_failed" ? 1 : 0,
          });
          await Promise.all([loadSendQueue(), loadNormalMessages(senderAccountId)]);

          if (queueItem.status !== "sent") {
            const reason =
              queueItem.last_error_message ??
              (queueItem.status === "queued"
                ? "SMTP server did not accept the message yet; it remains queued for retry."
                : `Send queue finished with status ${queueItem.status}.`);
            setError({
              code: queueItem.last_error_code ?? `send_${queueItem.status}`,
              user_message: `邮件尚未发送成功：${reason}`,
              correlation_id: queueItem.id,
            });
            setStatusMessage(`邮件尚未发送成功：${reason}`);
            return false;
          }

          if (persistedDraftId) {
            await invoke<MessageLocalActionDto>("message_delete_local_draft", {
              request: { draft_id: persistedDraftId },
            });
            await loadNormalMessages(senderAccountId);
          }
          showStatusToast(`邮件已发送给 ${targetAddresses}。`);
        } else {
          if (persistedDraftId) {
            await invoke<MessageLocalActionDto>("message_delete_local_draft", {
              request: { draft_id: persistedDraftId },
            });
          }
          await Promise.all([loadSendQueue(), loadNormalMessages(senderAccountId)]);
          showStatusToast(
            `已安排定时发送：${formatComposeScheduleDate(new Date(scheduledAt))}。`,
          );
        }

        setSendTargetAddress("");
        setComposeCcAddress("");
        setComposeBccAddress("");
        setComposeRecipientDrafts({ to: "", cc: "", bcc: "" });
        setComposeCcOpen(false);
        setComposeBccOpen(false);
        setComposeContactPickerField(null);
        setComposeRecipientMenu(null);
        setSendSubject("");
        setDraftBodyText("");
        setComposeSchedulePreset(null);
        setComposeScheduledAtIso(null);
        window.localStorage.removeItem(COMPOSE_DRAFT_STORAGE_KEY);
        setComposeDraftDirty(false);
        setComposeDraftSavedAt(null);
        composeDraftRevisionRef.current += 1;
        composePersistedDraftIdRef.current = null;
        setComposePersistedDraftId(null);
        setError(null);
        return true;
      } catch (caught: unknown) {
        const errorDto = asErrorDto(caught);
        setError(errorDto);
        showStatusToast(`发送失败：${errorDto.user_message}`);
        await loadSendQueue();
        return false;
      } finally {
        setBusy(false);
      }
    }
  async function runSendQueueWorkerOnce() {
      setBusy(true);
      try {
        const result = await sendQueueClient.runSendQueueOnce();
        setLastSendWorkerRun(result);
        await loadSendQueue();
        setStatusMessage(
          `Send worker processed ${result.processed_count}; sent ${result.sent_count}, retry ${result.retry_count}, failed ${result.failed_count}.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function addAgentAccount() {
      setBusy(true);
      try {
        const account = await invoke<LegacyAccountDto>("agent_add_account", {
          request: {
            display_name: agentDisplayName,
            email_address: agentEmailAddress,
          },
        });
        await loadAgentAccounts();
        setSelectedAgentSenderId(account.id);
        setAgentEmailAddress("");
        setStatusMessage(
          `Added Agent account ${account.display_name}; it is hidden from normal account lists.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function addAgentService() {
      setBusy(true);
      try {
        const service = await invoke<AgentServiceDto>("agent_add_service", {
          request: {
            display_name: agentServiceName,
            email_address: agentServiceEmail,
            description: optionalValue(agentServiceDescription),
            service_kind: "email_agent",
            trust_level: agentTrustLevel,
            default_sender_account_id: selectedAgentSenderId,
          },
        });
        await loadAgentServices();
        setSelectedAgentServiceId(service.id);
        setAgentServiceEmail("");
        setAgentServiceDescription("");
        setStatusMessage(`Added remote Agent service ${service.display_name}.`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function sendAgentTask() {
      if (!selectedAgentSenderId || !selectedAgentServiceId) {
        setError({
          code: "agent_selection_required",
          user_message: "Select an Agent sender account and remote Agent service before sending.",
          correlation_id: "local-validation",
        });
        return;
      }

      setBusy(true);
      try {
        const result = await invoke<AgentSendTaskDto>("agent_send_task", {
          request: {
            agent_service_id: selectedAgentServiceId,
            sender_account_id: selectedAgentSenderId,
            subject: agentTaskSubject,
            body_text: agentTaskBody,
            confirm_restricted: confirmRestrictedAgent,
          },
        });
        setLastAgentTask(result);
        await Promise.all([loadAgentThreads(), loadSendQueue()]);
        setAgentTaskSubject("");
        setAgentTaskBody("");
        setStatusMessage(
          `Queued Agent task ${result.thread.subject}; queue ${result.queue_id} is ${result.queue_status}.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function loadAgentThreadDetail(threadId: string) {
      setBusy(true);
      try {
        const detail = await invoke<AgentThreadDetailDto>("agent_get_thread_detail", {
          request: { thread_id: threadId },
        });
        setSelectedAgentThreadDetail(detail);
        setStatusMessage(`Loaded Agent thread ${detail.thread.subject}.`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function loadPromotedMessages(accountId: string | null) {
      if (!accountId) {
        return [];
      }

      const messages = await invoke<AnonymousMessageDto[]>("message_list", {
        request: { scope: "promoted_account", account_id: accountId, include_archived: true },
      });
      setPromotedMessagesByAccount((current) => ({ ...current, [accountId]: messages }));
      return messages;
    }
  return {
    enqueueDraftSend, runSendQueueWorkerOnce, addAgentAccount, addAgentService, sendAgentTask, loadAgentThreadDetail, loadPromotedMessages,
  };
}

export type UseDeliveryAgentControllerResult = ReturnType<typeof useDeliveryAgentController>;
