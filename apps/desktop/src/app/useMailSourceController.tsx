import { useEffect, useMemo } from "react";
import { type AccountDto } from "../api/mailAccountClient";
import { sortVisibleMailMessagesByTime } from "../mail/mailSelectors";
import { temporaryMailboxRefreshFailureMessage } from "../mail/temporaryMailboxAdapter";
import { useEventCallback } from "../hooks/useEventCallback";
import { createNonOverlappingAsyncRunner } from "../utils/asyncTask";
import { MAIL_AUTO_SYNC_INTERVAL_MS } from "./appConfig";
import { asErrorDto, temporaryRefreshError } from "./appDomain";
import { sendQueueClient } from "./appRuntime";
import type { MailSource } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  loadSendQueue: (isCurrent?: () => boolean) => Promise<import("../api/sendQueueClient").SendQueueDto[]>;
  invalidateMessageDetailRequest: () => void;
  loadPromotedMessages: (accountId: string) => Promise<import("./appTypes").AnonymousMessageDto[]>;
  rememberModalReturnFocus: () => void;
  createTempMailbox: () => Promise<void>;
  showStatusToast: (message: string) => void;
  refreshAnonymousMailOnce: () => Promise<import("../mail/temporaryMailboxAdapter").TemporaryMailboxRefreshView>;
  loadRecentCodes: (tempMailboxId?: string, isCurrent?: () => boolean) => Promise<import("../mail/mailSearch").VerificationCodeDto[]>;
};

export function useMailSourceController(appState: AppState, dependencies: Dependencies) {
  const {
    normalAccounts, agentAccounts, setLastSendWorkerRun, setStatusMessage, agentServices, selectedAgentServiceId, selectedAgentSenderId, agentThreads,
    anonymousMessages, normalMessagesByAccount, promotedMessagesByAccount, tempMailboxes, mailSourceId, setMailSourceId, setSelectedMailMessageId, setSelectedMailConversationKey,
    setSelectedMessageDetail, setSelectedNewsletterSubscription, setMailSourceDrawerOpen, setMailSourceDropdownOpen, setSelectedNormalAccountId, setMailAccountPanelOpen, mailAutoSyncInFlightRef, setMailSyncInProgress,
    setBusy, setRecentCodes, setError, activeView,
  } = appState;
  const {
    loadSendQueue, invalidateMessageDetailRequest, loadPromotedMessages, rememberModalReturnFocus, createTempMailbox, showStatusToast, refreshAnonymousMailOnce, loadRecentCodes,
  } = dependencies;
  const promotedAccounts = useMemo(
      () => normalAccounts.filter((account) => account.kind === "normal_upgraded_temp"),
      [normalAccounts],
    );
  const normalImapAccounts = useMemo(
      () => normalAccounts.filter((account) => account.kind === "normal_long_lived"),
      [normalAccounts],
    );
  const sendEnabledAccounts: AccountDto[] = [];
  const sendEnabledAgentAccounts = useMemo(
      () => agentAccounts.filter((account) => account.send_status === "enabled"),
      [agentAccounts],
    );
  const scheduledSendWorkerTask = useEventCallback(async (isCurrent: () => boolean) => {
        try {
          const result = await sendQueueClient.runSendQueueDueBatch({ limit: 10 });
          if (!isCurrent()) {
            return;
          }
          if (result.processed_count > 0) {
            setLastSendWorkerRun(result);
            await loadSendQueue(isCurrent);
            if (!isCurrent()) {
              return;
            }
            setStatusMessage(
              `Scheduled send worker processed ${result.processed_count}; sent ${result.sent_count}, retry ${result.retry_count}, failed ${result.failed_count}.`,
            );
          }
        } catch (caught: unknown) {
          if (isCurrent()) {
            const errorDto = asErrorDto(caught);
            setStatusMessage(`Scheduled send worker could not run: ${errorDto.user_message}`);
          }
        }
    });
  const runScheduledSendWorker = useMemo(
      () => createNonOverlappingAsyncRunner(scheduledSendWorkerTask),
      [scheduledSendWorkerTask],
    );
  useEffect(() => {
      let cancelled = false;
      const isCurrent = () => !cancelled;

      void runScheduledSendWorker(isCurrent);
      const intervalId = window.setInterval(() => void runScheduledSendWorker(isCurrent), 15000);

      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
      };
    }, [runScheduledSendWorker]);
  const selectedAgentService =
      agentServices.find((service) => service.id === selectedAgentServiceId) ?? null;
  const selectedAgentSender =
      agentAccounts.find((account) => account.id === selectedAgentSenderId) ?? null;
  const needsAttentionThreads = agentThreads.filter((thread) => thread.status === "needs_attention");
  const tempVisibleMessages = useMemo(
      () =>
        sortVisibleMailMessagesByTime(
          anonymousMessages.map((message) => ({
            ...message,
            sourceLabel: "临时邮箱",
            sourceId: "temp",
          })),
        ),
      [anonymousMessages],
    );
  const normalVisibleMessages = useMemo(
      () =>
        sortVisibleMailMessagesByTime(
          normalImapAccounts.flatMap((account) =>
            (normalMessagesByAccount[account.id] ?? []).map((message) => ({
              ...message,
              sourceLabel: account.display_name,
              sourceId: `account:${account.id}`,
              account_id: account.id,
            })),
          ),
        ),
      [normalImapAccounts, normalMessagesByAccount],
    );
  const promotedVisibleMessages = useMemo(
      () =>
        sortVisibleMailMessagesByTime(
          promotedAccounts.flatMap((account) =>
            (promotedMessagesByAccount[account.id] ?? []).map((message) => ({
              ...message,
              sourceLabel: account.display_name,
              sourceId: `promoted:${account.id}`,
              account_id: account.id,
            })),
          ),
        ),
      [promotedAccounts, promotedMessagesByAccount],
    );
  const allVisibleMailMessages = useMemo(
      () =>
        sortVisibleMailMessagesByTime([
          ...tempVisibleMessages,
          ...normalVisibleMessages,
          ...promotedVisibleMessages,
        ]),
      [normalVisibleMessages, promotedVisibleMessages, tempVisibleMessages],
    );
  const mailSources: MailSource[] = [
      {
        id: "all",
        label: "全部",
        meta: `${allVisibleMailMessages.length} 封已加载`,
        tone: "signal",
      },
      {
        id: "temp",
        label: "临时",
        meta: `${tempVisibleMessages.length} 封邮件 / ${tempMailboxes.length} 个邮箱`,
        tone: "cyan",
      },
      ...normalImapAccounts.map((account): MailSource => ({
        id: `account:${account.id}`,
        label: account.display_name,
        meta: `${normalMessagesByAccount[account.id]?.length ?? 0} 封邮件 / ${
          account.primary_address ?? account.id
        }`,
        tone: "info",
      })),
      ...promotedAccounts.map((account): MailSource => ({
        id: `promoted:${account.id}`,
        label: account.display_name,
        meta: `${promotedMessagesByAccount[account.id]?.length ?? 0} 封邮件 / ${
          account.primary_address ?? "临时升级邮箱"
        }`,
        tone: "cyan",
      })),
    ];
  const selectedMailSource = mailSources.find((source) => source.id === mailSourceId) ?? mailSources[0];
  function selectMailSource(sourceId: string) {
      invalidateMessageDetailRequest();
      setMailSourceId(sourceId);
      setSelectedMailMessageId(null);
      setSelectedMailConversationKey(null);
      setSelectedMessageDetail(null);
      setSelectedNewsletterSubscription(null);
      setMailSourceDrawerOpen(false);
      setMailSourceDropdownOpen(false);
      if (sourceId.startsWith("account:")) {
        const accountId = sourceId.slice("account:".length);
        setSelectedNormalAccountId(accountId);
        setStatusMessage("This account is HTTP-owned. Message synchronization becomes available in M6.");
        return;
      }
      if (sourceId.startsWith("promoted:")) {
        const accountId = sourceId.slice("promoted:".length);
        void loadPromotedMessages(accountId);
        return;
      }
      if (sourceId === "temp") {
        setSelectedNormalAccountId(null);
      }
    }
  function openMailAccountPanelFromSourceDropdown() {
      rememberModalReturnFocus();
      setMailSourceDropdownOpen(false);
      setMailSourceDrawerOpen(false);
      setMailAccountPanelOpen(true);
    }
  function createTempMailboxFromSourceDropdown() {
      setMailSourceDropdownOpen(false);
      setMailSourceDrawerOpen(false);
      void createTempMailbox();
    }
  async function syncCurrentMailSource(options: { silent?: boolean } = {}) {
      const silent = options.silent === true;
      if (mailAutoSyncInFlightRef.current) {
        if (!silent) {
          showStatusToast("邮件同步正在进行中。");
        }
        return;
      }

      const publishSyncStatus = (message: string) => {
        if (silent) {
          setStatusMessage(message);
        } else {
          showStatusToast(message);
        }
      };

      mailAutoSyncInFlightRef.current = true;
      setMailSyncInProgress(true);
      if (!silent) {
        setBusy(true);
      }
      try {
        if (mailSourceId === "all") {
          const tempResult = await refreshAnonymousMailOnce();
          await Promise.all(promotedAccounts.map((account) => loadPromotedMessages(account.id)));
          const codes = await loadRecentCodes();
          setRecentCodes(codes);

          publishSyncStatus(
            temporaryMailboxRefreshFailureMessage(tempResult) ??
              `Synced available mail: temp fetched ${tempResult.fetched_count}, inserted ${tempResult.inserted_count}; normal-account messages remain unavailable until M6.`,
          );
          const refreshError = temporaryRefreshError(tempResult);
          if (refreshError || !silent) {
            setError(refreshError);
          }
          return;
        }

        if (mailSourceId === "temp") {
          const result = await refreshAnonymousMailOnce();
          publishSyncStatus(
            temporaryMailboxRefreshFailureMessage(result) ??
              `Synced temp mail: fetched ${result.fetched_count}, inserted ${result.inserted_count}.`,
          );
          const refreshError = temporaryRefreshError(result);
          if (refreshError || !silent) {
            setError(refreshError);
          }
          return;
        }

        if (mailSourceId.startsWith("account:")) {
          publishSyncStatus(
            `${selectedMailSource.label} account metadata is current; message synchronization becomes available in M6.`,
          );
          if (!silent) {
            setError(null);
          }
          return;
        }

        if (mailSourceId.startsWith("promoted:")) {
          const accountId = mailSourceId.slice("promoted:".length);
          const messages = await loadPromotedMessages(accountId);
          const codes = await loadRecentCodes();
          setRecentCodes(codes);
          publishSyncStatus(`Reloaded ${selectedMailSource.label}: ${messages.length} historical messages.`);
          if (!silent) {
            setError(null);
          }
          return;
        }

        const result = await refreshAnonymousMailOnce();
        publishSyncStatus(
          temporaryMailboxRefreshFailureMessage(result) ??
            `Synced current source: fetched ${result.fetched_count}, inserted ${result.inserted_count}.`,
        );
        const refreshError = temporaryRefreshError(result);
        if (refreshError || !silent) {
          setError(refreshError);
        }
      } catch (caught: unknown) {
        const errorDto = asErrorDto(caught);
        if (silent) {
          setStatusMessage(`Auto sync failed: ${errorDto.user_message}`);
        } else {
          setError(errorDto);
        }
      } finally {
        mailAutoSyncInFlightRef.current = false;
        setMailSyncInProgress(false);
        if (!silent) {
          setBusy(false);
        }
      }
    }
  const syncCurrentMailSourceEvent = useEventCallback(syncCurrentMailSource);
  useEffect(() => {
      if (activeView !== "mail") {
        return undefined;
      }

      const autoSyncableSource =
        mailSourceId === "all" ||
        mailSourceId === "temp" ||
        mailSourceId.startsWith("promoted:");
      if (!autoSyncableSource) {
        return undefined;
      }

      let disposed = false;
      const runAutoSync = () => {
        if (disposed || mailAutoSyncInFlightRef.current) {
          return;
        }
        void syncCurrentMailSourceEvent({ silent: true });
      };

      const intervalId = window.setInterval(runAutoSync, MAIL_AUTO_SYNC_INTERVAL_MS);
      return () => {
        disposed = true;
        window.clearInterval(intervalId);
      };
    }, [activeView, mailSourceId, syncCurrentMailSourceEvent]);
  return {
    promotedAccounts, normalImapAccounts, sendEnabledAccounts, sendEnabledAgentAccounts, selectedAgentService, selectedAgentSender, needsAttentionThreads, tempVisibleMessages,
    allVisibleMailMessages, mailSources, selectedMailSource, selectMailSource, openMailAccountPanelFromSourceDropdown, createTempMailboxFromSourceDropdown, syncCurrentMailSource,
  };
}

export type UseMailSourceControllerResult = ReturnType<typeof useMailSourceController>;
