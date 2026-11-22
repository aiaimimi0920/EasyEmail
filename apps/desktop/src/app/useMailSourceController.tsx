import { useEffect, useMemo } from "react";
import { formatAccountSyncBadge, type AccountDto, type AccountSyncStatusDto } from "../api/mailAccountClient";
import { sortVisibleMailMessagesByTime } from "../mail/mailSelectors";
import { temporaryMailboxRefreshFailureMessage } from "../mail/temporaryMailboxAdapter";
import { useEventCallback } from "../hooks/useEventCallback";
import { createNonOverlappingAsyncRunner } from "../utils/asyncTask";
import { MAIL_AUTO_SYNC_INTERVAL_MS } from "./appConfig";
import { asErrorDto, temporaryRefreshError } from "./appDomain";
import { mailAccountClient } from "./appRuntime";
import type { MailSource } from "./appTypes";
import {
  attachTemporaryMailboxSources,
  buildTemporaryMailboxSources,
  temporaryMailboxIdFromSourceId,
  temporaryMailboxSourceId,
} from "./temporaryMailSources";
import type { AppState } from "./useAppState";

type Dependencies = {
  loadSendQueue: (isCurrent?: () => boolean) => Promise<import("../api/sendQueueClient").SendQueueDto[]>;
  invalidateMessageDetailRequest: () => void;
  loadNormalMessages: (accountId: string) => Promise<import("./appTypes").AnonymousMessageDto[]>;
  loadNormalAccounts: () => Promise<AccountDto[]>;
  loadNormalAccountSyncStatus: (accountId: string, isCurrent?: () => boolean) => Promise<AccountSyncStatusDto>;
  loadPromotedMessages: (accountId: string) => Promise<import("./appTypes").AnonymousMessageDto[]>;
  rememberModalReturnFocus: () => void;
  createTempMailbox: () => Promise<string | null>;
  showStatusToast: (message: string) => void;
  refreshAnonymousMailOnce: () => Promise<import("../mail/temporaryMailboxAdapter").TemporaryMailboxRefreshView>;
  loadRecentCodes: (tempMailboxId?: string, isCurrent?: () => boolean) => Promise<import("../mail/mailSearch").VerificationCodeDto[]>;
};

export function useMailSourceController(appState: AppState, dependencies: Dependencies) {
  const {
    normalAccounts, normalAccountSyncByAccount, setNormalAccountSyncByAccount, agentAccounts, setStatusMessage, agentServices, selectedAgentServiceId, selectedAgentSenderId, agentThreads,
    anonymousMessages, normalMessagesByAccount, promotedMessagesByAccount, tempMailboxes, mailSourceId, setMailSourceId, setSelectedMailMessageId, setSelectedMailConversationKey,
    setSelectedMessageDetail, setSelectedNewsletterSubscription, setMailSourceDrawerOpen, setMailSourceDropdownOpen, setSelectedNormalAccountId, setMailAccountPanelOpen, mailAutoSyncInFlightRef, setMailSyncInProgress,
    setBusy, setRecentCodes, setError, activeView, setSelectedTempMailboxId,
  } = appState;
  const {
    loadSendQueue, invalidateMessageDetailRequest, loadNormalMessages, loadNormalAccounts, loadNormalAccountSyncStatus, loadPromotedMessages, rememberModalReturnFocus, createTempMailbox, showStatusToast, refreshAnonymousMailOnce, loadRecentCodes,
  } = dependencies;
  const promotedAccounts = useMemo(
      () => normalAccounts.filter((account) => account.kind === "normal_upgraded_temp"),
      [normalAccounts],
    );
  const normalImapAccounts = useMemo(
      () => normalAccounts.filter((account) => account.kind === "normal_long_lived"),
      [normalAccounts],
    );
  const sendEnabledAccounts = useMemo(
      () => normalAccounts.filter((account) => account.send_status === "enabled"),
      [normalAccounts],
    );
  const sendEnabledAgentAccounts = useMemo(
      () => agentAccounts.filter((account) => account.send_status === "enabled"),
      [agentAccounts],
    );
  const observeSendQueueTask = useEventCallback(async (isCurrent: () => boolean) => {
        try {
          await loadSendQueue(isCurrent);
        } catch {
          // Background status observation must not interrupt foreground work.
        }
    });
  const refreshVisibleSendQueue = useMemo(
      () => createNonOverlappingAsyncRunner(observeSendQueueTask),
      [observeSendQueueTask],
    );
  useEffect(() => {
      if (activeView !== "queue") {
        return undefined;
      }
      let cancelled = false;
      const isCurrent = () => !cancelled;

      void refreshVisibleSendQueue(isCurrent);
      const intervalId = window.setInterval(() => void refreshVisibleSendQueue(isCurrent), 5000);

      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
      };
    }, [activeView, refreshVisibleSendQueue]);
  const selectedAgentService =
      agentServices.find((service) => service.id === selectedAgentServiceId) ?? null;
  const selectedAgentSender =
      agentAccounts.find((account) => account.id === selectedAgentSenderId) ?? null;
  const needsAttentionThreads = agentThreads.filter((thread) => thread.status === "needs_attention");
  const tempVisibleMessages = useMemo(
      () =>
        sortVisibleMailMessagesByTime(
          attachTemporaryMailboxSources(anonymousMessages, tempMailboxes),
        ),
      [anonymousMessages, tempMailboxes],
    );
  const temporaryMailSources = useMemo(
      () => buildTemporaryMailboxSources(tempMailboxes, anonymousMessages),
      [anonymousMessages, tempMailboxes],
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
      ...temporaryMailSources,
      ...normalImapAccounts.map((account): MailSource => ({
        id: `account:${account.id}`,
        label: account.display_name,
        meta: `${normalMessagesByAccount[account.id]?.length ?? 0} 封邮件 · ${formatAccountSyncBadge(normalAccountSyncByAccount[account.id])} / ${
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
        void loadNormalMessages(accountId);
        void loadNormalAccountSyncStatus(accountId).catch(() => undefined);
        const badge = formatAccountSyncBadge(normalAccountSyncByAccount[accountId]);
        setStatusMessage(`当前邮箱同步状态：${badge}。`);
        return;
      }
      if (sourceId.startsWith("promoted:")) {
        const accountId = sourceId.slice("promoted:".length);
        void loadPromotedMessages(accountId);
        return;
      }
      const tempMailboxId = temporaryMailboxIdFromSourceId(sourceId);
      if (tempMailboxId) {
        setSelectedNormalAccountId(null);
        setSelectedTempMailboxId(tempMailboxId);
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
  async function createAndSelectTempMailbox() {
      setMailSourceDropdownOpen(false);
      setMailSourceDrawerOpen(false);
      const tempMailboxId = await createTempMailbox();
      if (tempMailboxId) {
        selectMailSource(temporaryMailboxSourceId(tempMailboxId));
      }
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
          const syncableNormalAccounts = normalImapAccounts.filter(
            (account) => account.status !== "disabled" && account.receive_status !== "disabled",
          );
          const [tempResult, normalOutcomes] = await Promise.all([
            refreshAnonymousMailOnce(),
            Promise.allSettled(
              syncableNormalAccounts.map(async (account) => {
                const synced = await mailAccountClient.syncAccount(account.id);
                setNormalAccountSyncByAccount((current) => ({
                  ...current,
                  [account.id]: synced.status,
                }));
                await loadNormalMessages(account.id);
                return synced;
              }),
            ),
          ]);
          await Promise.all(promotedAccounts.map((account) => loadPromotedMessages(account.id)));
          let normalFetched = 0;
          let normalInserted = 0;
          let normalFailureCount = 0;
          for (let index = 0; index < normalOutcomes.length; index += 1) {
            const outcome = normalOutcomes[index];
            const account = syncableNormalAccounts[index];
            if (outcome?.status === "fulfilled") {
              normalFetched += outcome.value.fetched_count;
              normalInserted += outcome.value.inserted_count;
            } else if (account) {
              normalFailureCount += 1;
              await loadNormalAccountSyncStatus(account.id).catch(() => undefined);
            }
          }
          if (syncableNormalAccounts.length > 0) {
            await loadNormalAccounts().catch(() => undefined);
          }
          const codes = await loadRecentCodes();
          setRecentCodes(codes);

          const failureSuffix = normalFailureCount > 0 ? `；${normalFailureCount} 个长效账户同步异常（已保留本地缓存）` : "";
          publishSyncStatus(
            temporaryMailboxRefreshFailureMessage(tempResult) ??
              `已同步全部邮件：临时拉取 ${tempResult.fetched_count} / 新增 ${tempResult.inserted_count}，长效拉取 ${normalFetched} / 新增 ${normalInserted}${failureSuffix}。`,
          );
          const refreshError = temporaryRefreshError(tempResult);
          if (refreshError || !silent) {
            setError(refreshError);
          }
          return;
        }

        if (mailSourceId === "temp" || temporaryMailboxIdFromSourceId(mailSourceId)) {
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
          const accountId = mailSourceId.slice("account:".length);
          let synced;
          try {
            synced = await mailAccountClient.syncAccount(accountId);
          } catch (syncError: unknown) {
            await loadNormalAccountSyncStatus(accountId).catch(() => undefined);
            await loadNormalAccounts().catch(() => undefined);
            throw syncError;
          }
          setNormalAccountSyncByAccount((current) => ({
            ...current,
            [accountId]: synced.status,
          }));
          await Promise.all([
            loadNormalMessages(accountId),
            loadNormalAccounts(),
          ]);
          const codes = await loadRecentCodes();
          setRecentCodes(codes);
          publishSyncStatus(
            `已同步 ${selectedMailSource.label}：拉取 ${synced.fetched_count} 封，新增 ${synced.inserted_count} 封。`,
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
        temporaryMailboxIdFromSourceId(mailSourceId) !== null ||
        mailSourceId.startsWith("account:") ||
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
    allVisibleMailMessages, mailSources, selectedMailSource, selectMailSource, openMailAccountPanelFromSourceDropdown, createAndSelectTempMailbox, syncCurrentMailSource,
  };
}

export type UseMailSourceControllerResult = ReturnType<typeof useMailSourceController>;
