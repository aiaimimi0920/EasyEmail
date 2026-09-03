import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { temporaryMailboxViewFromSession, temporaryObservedMessageView, temporaryVerificationCodeView } from "../mail/temporaryMailboxAdapter";
import { type VerificationCodeDto } from "../mail/mailSearch";
import { TOAST_FADE_MS, TOAST_VISIBLE_MS } from "./appConfig";
import { asErrorDto, mergeByIdentity } from "./appDomain";
import { avatarSettingsClient, bundledCoreClient, contactClient, mailAccountClient, mailTaxonomyClient, newsletterClient, platformAccountClient, sendQueueClient, settingsClient } from "./appRuntime";
import type { CoreTemporaryState, LegacyAccountDto, AgentServiceDto, AgentThreadDto, AnonymousMessageDto, MessageCache, NewsletterSubscriptionCache } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  clearToastLifecycleTimers: () => void;
  toastKey: string | null;
  toastTone: "copy" | "status" | "error";
  refreshComposeActiveFormats: () => void;
};

export function useInitialDataController(appState: AppState, dependencies: Dependencies) {
  const {
    setNewsletterSubscriptionsByAccount, setMailFolders, setMailLabels, coreObservedMessagesRef, setInitializing, setStatusMessage, setBusy, setSettings,
    setAvatarSettings, setPlatformSession, setServiceUrl, canonicalNormalAccountIdsRef, setNormalAccounts, setTempMailboxes, setAnonymousMessages, setNormalMessagesByAccount,
    setPromotedMessagesByAccount, setRecentCodes, setSendQueue, setContacts, setAgentAccounts, setAgentServices, setAgentThreads, setSelectedAgentSenderId,
    setSelectedAgentServiceId, setError, mountedRef, initialLoadRequestRef, setSelectedTempMailboxId, tempMailboxes, setLastAuthenticationLink, selectedTempMailboxId,
    setToastVisibleKey, setToastFading, toastFadeTimerRef, toastRemoveTimerRef, setStatusToast, setCopyToast, copyToastTimerRef, composePopoverOpen,
    composePopoverMinimized, railCollapsed, setPlatformAccountMenuOpen, setRailExpandedReady, railExpandedReady, pendingMailTaxonomyAutoOpenKind, setMailTaxonomySectionExpanded, setPendingMailTaxonomyAutoOpenKind,
  } = appState;
  const {
    clearToastLifecycleTimers, toastKey, toastTone, refreshComposeActiveFormats,
  } = dependencies;
  async function loadNewsletterSubscriptions(
      accountId: string | null,
      isCurrent: () => boolean = () => true,
    ) {
      if (!accountId) {
        return [];
      }
      const subscriptions = await newsletterClient.listNewsletterSubscriptions({
        account_id: accountId,
      });
      if (!isCurrent()) {
        return subscriptions;
      }
      setNewsletterSubscriptionsByAccount((current) => ({
        ...current,
        [accountId]: subscriptions,
      }));
      return subscriptions;
    }
  async function loadMailTaxonomyItems(isCurrent: () => boolean = () => true) {
      const [folders, labels] = await Promise.all([
        mailTaxonomyClient.listMailTaxonomyItems({ kind: "folder" }),
        mailTaxonomyClient.listMailTaxonomyItems({ kind: "label" }),
      ]);
      if (!isCurrent()) {
        return { folders, labels };
      }
      setMailFolders(folders);
      setMailLabels(labels);
      return { folders, labels };
    }
  async function loadCoreTemporaryState(): Promise<CoreTemporaryState> {
      const hostId = await bundledCoreClient.getHostId();
      const [{ sessions }, { instances }, { messages: allObservedMessages }] = await Promise.all([
        bundledCoreClient.queryMailboxSessions({
          hostId,
          newestFirst: true,
          limit: 500,
        }),
        bundledCoreClient.queryProviderInstances(),
        bundledCoreClient.queryObservedMessages({ newestFirst: true, limit: 5000 }),
      ]);
      const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
      const mailboxes = sessions.map((session) =>
        temporaryMailboxViewFromSession(session, instancesById.get(session.providerInstanceId)),
      );
      const mailboxesById = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
      const sessionIds = new Set(sessions.map((session) => session.id));
      const observedMessages = allObservedMessages.filter((message) =>
        sessionIds.has(message.sessionId),
      );
      coreObservedMessagesRef.current = new Map(
        observedMessages.map((message) => [message.id, message]),
      );
      const messages = observedMessages.flatMap((message) => {
        const mailbox = mailboxesById.get(message.sessionId);
        return mailbox ? [temporaryObservedMessageView(message, mailbox)] : [];
      });
      const codes = observedMessages.flatMap((message) => {
        const mailbox = mailboxesById.get(message.sessionId);
        if (!mailbox || !message.extractedCode) return [];
        return [
          temporaryVerificationCodeView(
            {
              sessionId: message.sessionId,
              providerInstanceId: message.providerInstanceId,
              code: message.extractedCode,
              source: message.codeSource ?? "text",
              observedMessageId: message.id,
              receivedAt: message.observedAt,
              candidates: message.extractedCandidates,
            },
            mailbox,
            message,
          ),
        ];
      });
      return {
        mailboxes,
        messages,
        codes: codes.slice(0, 100),
      };
    }
  async function loadInitialState(isCurrent: () => boolean = () => true) {
      setInitializing(true);
      setStatusMessage("正在启动本地 EasyEmail 核心并加载邮件数据…");
      setBusy(true);
      try {
        const [
          ,
          settingsResult,
          avatarSettingsResult,
          coreTemporaryState,
          platformSessionResult,
          accountsResult,
          messagesResult,
          codesResult,
          sendQueueResult,
          contactsResult,
          agentAccountsResult,
          agentServicesResult,
          agentThreadsResult,
          taxonomyResult,
        ] = await Promise.all([
          bundledCoreClient.getCatalog(),
          settingsClient.getEasyEmailSettings(),
          avatarSettingsClient.getAvatarSettings(),
          loadCoreTemporaryState(),
          platformAccountClient.getPlatformAccountSession(),
          mailAccountClient.listNormalAccounts(),
          invoke<AnonymousMessageDto[]>("message_list", {
            request: { scope: "anonymous", account_id: null, include_archived: true },
          }),
          invoke<VerificationCodeDto[]>("verification_list_recent", {
            request: { temp_mailbox_id: null, limit: 100 },
          }),
          sendQueueClient.listSendQueue({ limit: 25 }),
          contactClient.listContacts(),
          invoke<LegacyAccountDto[]>("agent_list_accounts"),
          invoke<AgentServiceDto[]>("agent_list_services"),
          invoke<AgentThreadDto[]>("agent_list_threads"),
          loadMailTaxonomyItems(isCurrent),
        ]);
        if (!isCurrent()) {
          return;
        }
        // Normal-account messages and derived newsletters remain owned by the M4/M6
        // migration. Do not cross-read the legacy Rust database using core account IDs.
        const normalMessageCache: MessageCache = {};
        const promotedMessageCache: MessageCache = {};
        const newsletterSubscriptionCache: NewsletterSubscriptionCache = {};

        if (!isCurrent()) {
          return;
        }

        setSettings(settingsResult);
        setAvatarSettings(avatarSettingsResult);
        setPlatformSession(platformSessionResult);
        setServiceUrl(settingsResult.service_url ?? "");
        canonicalNormalAccountIdsRef.current = new Set(accountsResult.map((account) => account.id));
        setNormalAccounts(accountsResult);
        setTempMailboxes(coreTemporaryState.mailboxes);
        setAnonymousMessages(
          mergeByIdentity(
            coreTemporaryState.messages,
            messagesResult,
            (message) => message.message_id,
          ),
        );
        setNormalMessagesByAccount(normalMessageCache);
        setPromotedMessagesByAccount(promotedMessageCache);
        setNewsletterSubscriptionsByAccount(newsletterSubscriptionCache);
        setMailFolders(taxonomyResult.folders);
        setMailLabels(taxonomyResult.labels);
        setRecentCodes(
          mergeByIdentity(coreTemporaryState.codes, codesResult, (code) => code.id),
        );
        setSendQueue(sendQueueResult);
        setContacts(contactsResult);
        setAgentAccounts(agentAccountsResult);
        setAgentServices(agentServicesResult);
        setAgentThreads(agentThreadsResult);
        setSelectedAgentSenderId(agentAccountsResult[0]?.id ?? null);
        setSelectedAgentServiceId(agentServicesResult[0]?.id ?? null);
        setStatusMessage("Local core is ready.");
        setError(null);
      } catch (caught: unknown) {
        if (isCurrent()) {
          setError(asErrorDto(caught));
          setStatusMessage("NMail could not load its local state.");
        }
      } finally {
        if (isCurrent()) {
          setInitializing(false);
          setBusy(false);
        }
      }
    }
  useEffect(() => {
      mountedRef.current = true;
      const requestId = ++initialLoadRequestRef.current;
      const isCurrent = () => initialLoadRequestRef.current === requestId;
      void loadInitialState(isCurrent);
      return () => {
        initialLoadRequestRef.current += 1;
        mountedRef.current = false;
        setBusy(false);
      };
    }, []);
  useEffect(() => {
      setSelectedTempMailboxId((current) => {
        if (tempMailboxes.some((mailbox) => mailbox.id === current)) {
          return current;
        }
        return (
          tempMailboxes.find((mailbox) => mailbox.lifecycle_state === "active")?.id ??
          tempMailboxes[0]?.id ??
          ""
        );
      });
    }, [tempMailboxes]);
  useEffect(() => {
      setLastAuthenticationLink(null);
    }, [selectedTempMailboxId]);
  useEffect(() => {
      clearToastLifecycleTimers();

      if (!toastKey) {
        setToastVisibleKey(null);
        setToastFading(false);
        return undefined;
      }

      setToastVisibleKey(toastKey);
      setToastFading(false);
      if (toastTone === "error") {
        return () => clearToastLifecycleTimers();
      }
      toastFadeTimerRef.current = window.setTimeout(() => {
        setToastFading(true);
      }, TOAST_VISIBLE_MS);
      toastRemoveTimerRef.current = window.setTimeout(() => {
        setToastVisibleKey(null);
        setToastFading(false);
        if (toastTone === "status") {
          setStatusToast(null);
        }
        if (toastTone === "copy") {
          setCopyToast(null);
        }
        toastRemoveTimerRef.current = null;
      }, TOAST_VISIBLE_MS + TOAST_FADE_MS);

      return () => clearToastLifecycleTimers();
    }, [toastKey]);
  useEffect(
      () => () => {
        if (copyToastTimerRef.current !== null) {
          window.clearTimeout(copyToastTimerRef.current);
        }
        clearToastLifecycleTimers();
      },
      [],
    );
  useEffect(() => {
      const refresh = () => refreshComposeActiveFormats();
      document.addEventListener("selectionchange", refresh);
      return () => document.removeEventListener("selectionchange", refresh);
    }, []);
  useEffect(() => {
      if (!composePopoverOpen || composePopoverMinimized) {
        return undefined;
      }
      const focusFrame = window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>("[data-compose-initial-focus]")
          ?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(focusFrame);
    }, [composePopoverOpen, composePopoverMinimized]);
  useEffect(() => {
      if (railCollapsed) {
        setPlatformAccountMenuOpen(false);
      }
    }, [railCollapsed]);
  useEffect(() => {
      if (railCollapsed) {
        setRailExpandedReady(false);
        return;
      }

      const timer = window.setTimeout(() => setRailExpandedReady(true), 320);
      return () => window.clearTimeout(timer);
    }, [railCollapsed]);
  useEffect(() => {
      if (railExpandedReady && pendingMailTaxonomyAutoOpenKind) {
        setMailTaxonomySectionExpanded(
          pendingMailTaxonomyAutoOpenKind === "folder"
            ? { folder: true, label: false }
            : { folder: false, label: true },
        );
        setPendingMailTaxonomyAutoOpenKind(null);
      }
    }, [pendingMailTaxonomyAutoOpenKind, railExpandedReady]);
  return {
    loadNewsletterSubscriptions, loadMailTaxonomyItems, loadCoreTemporaryState,
  };
}

export type UseInitialDataControllerResult = ReturnType<typeof useInitialDataController>;
