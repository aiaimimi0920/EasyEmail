import { openUrl } from "@tauri-apps/plugin-opener";
import { temporaryMailboxRecordFromOpenResult, temporaryMailboxRefreshView, temporaryVerificationCodeView } from "../mail/temporaryMailboxAdapter";
import { asErrorDto, mergeByIdentity, optionalValue, temporaryRefreshError } from "./appDomain";
import { bundledCoreClient } from "./appRuntime";
import type { TempMailboxDto, CoreTemporaryState } from "./appTypes";
import { runTemporaryMailboxCreation } from "./temporaryMailboxCreation";
import type { AppState } from "./useAppState";

type Dependencies = {
  loadCoreTemporaryState: () => Promise<import("./appTypes").CoreTemporaryState>;
  loadNormalAccounts: () => Promise<import("../api/mailAccountClient").AccountDto[]>;
  showStatusToast: (message: string) => void;
};

export function useTemporaryMailboxController(appState: AppState, dependencies: Dependencies) {
  const {
    setTempMailboxes, setAnonymousMessages, setRecentCodes, tempMailboxes, selectedTempMailboxId, setError, setBusy, targetService,
    note, canonicalNormalAccountIdsRef, setNormalAccounts, setSelectedTempMailboxId, setTargetService, setNote, waitForCode, setWaitingMailboxId,
    setStatusMessage, setLastRefresh, tempRecoveryEmail, tempRecoveryProviderType, setTempRecoveryEmail, setLastAuthenticationLink, lastAuthenticationLink, tempMailboxFromContains,
    tempOutcomeFailureReason, setTempOutcomeFailureReason, waitingMailboxId, tempSendTo, tempSendSubject, tempSendBody, setTempSendSubject, setTempSendBody,
    coreObservedMessagesRef,
  } = appState;
  const {
    loadCoreTemporaryState, loadNormalAccounts, showStatusToast,
  } = dependencies;
  function applyCoreTemporaryState(coreState: CoreTemporaryState) {
      setTempMailboxes(coreState.mailboxes);
      setAnonymousMessages((current) =>
        mergeByIdentity(coreState.messages, current, (message) => message.message_id),
      );
      setRecentCodes((current) =>
        mergeByIdentity(coreState.codes, current, (code) => code.id),
      );
    }
  function selectedTemporaryMailbox(): TempMailboxDto | null {
      const mailbox = tempMailboxes.find((candidate) => candidate.id === selectedTempMailboxId) ?? null;
      if (!mailbox) {
        setError({
          code: "TEMP_MAILBOX_SELECTION_REQUIRED",
          user_message: "Select a temporary mailbox before running this action.",
          correlation_id: "desktop-validation",
        });
      }
      return mailbox;
    }
  async function createTempMailbox(): Promise<string | null> {
      setBusy(true);
      try {
        let createdMessage = "Temporary mailbox created.";
        const creation = await runTemporaryMailboxCreation({
          openMailbox: async () => {
            const hostId = await bundledCoreClient.getHostId();
            const metadata = {
              source: "desktop-ui",
              ...(optionalValue(targetService) ? { targetService: targetService.trim() } : {}),
              ...(optionalValue(note) ? { note: note.trim() } : {}),
            };
            const { result } = await bundledCoreClient.openMailbox({
              hostId,
              provisionMode: "auto-create-if-missing",
              bindingMode: "shared-instance",
              metadata,
            });
            return temporaryMailboxRecordFromOpenResult(result);
          },
          loadCoreTemporaryState,
          loadNormalAccounts,
          onOpened: (mailboxRecord) => {
            setTempMailboxes((current) =>
              mergeByIdentity([mailboxRecord.view], current, (mailbox) => mailbox.id),
            );
            setSelectedTempMailboxId(mailboxRecord.view.id);
            setTargetService("");
            setNote("");
            createdMessage = waitForCode
              ? `Created ${mailboxRecord.view.email_address}; waiting for a verification code.`
              : `Created temporary mailbox ${mailboxRecord.view.email_address}.`;
            if (waitForCode) {
              setWaitingMailboxId(mailboxRecord.view.id);
            }
            showStatusToast(createdMessage);
            setError(null);
          },
          onCoreStateLoaded: (coreState, mailboxRecord) => {
            applyCoreTemporaryState({
              ...coreState,
              mailboxes: mergeByIdentity(
                coreState.mailboxes,
                [mailboxRecord.view],
                (mailbox) => mailbox.id,
              ),
            });
          },
          onNormalAccountsLoaded: (accounts) => {
            canonicalNormalAccountIdsRef.current = new Set(
              accounts.map((account) => account.id),
            );
            setNormalAccounts(accounts);
          },
        });
        if (creation.status === "failed") {
          setError(asErrorDto(creation.error));
          return null;
        }
        void creation.refreshCompletion.then(({ failedRefreshCount }) => {
          if (failedRefreshCount > 0) {
            setStatusMessage(
              `${createdMessage} ${failedRefreshCount} background list refresh(es) did not complete; use Sync to retry.`,
            );
          }
        });
        return creation.mailbox.view.id;
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
        return null;
      } finally {
        setBusy(false);
      }
    }
  async function refreshCoreMailboxes(
      target: { sessionId: string } | { hostId: string },
      isCurrent: () => boolean = () => true,
    ) {
      const { refresh } = "sessionId" in target
        ? await bundledCoreClient.refreshMailbox(target.sessionId)
        : await bundledCoreClient.refreshAnonymousMailboxes(target.hostId);
      const coreState = await loadCoreTemporaryState();
      const result = temporaryMailboxRefreshView(refresh);
      if (isCurrent()) {
        setLastRefresh(result);
        applyCoreTemporaryState(coreState);
      }
      return { result, coreState };
    }
  async function refreshAnonymousMailOnce() {
      const hostId = await bundledCoreClient.getHostId();
      return (await refreshCoreMailboxes({ hostId })).result;
    }
  async function refreshAnonymousMail() {
      setBusy(true);
      try {
        const result = await refreshAnonymousMailOnce();
        const refreshError = temporaryRefreshError(result);
        setStatusMessage(
          refreshError?.user_message ??
            `Anonymous refresh fetched ${result.fetched_count} messages and inserted ${result.inserted_count}.`,
        );
        setError(refreshError);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function refreshMailbox(tempMailboxId: string) {
      setBusy(true);
      try {
        const { result } = await refreshCoreMailboxes({ sessionId: tempMailboxId });
        const refreshError = temporaryRefreshError(result);
        setStatusMessage(
          refreshError?.user_message ??
            `Mailbox refresh fetched ${result.fetched_count} messages and inserted ${result.inserted_count}.`,
        );
        setError(refreshError);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function recoverTempMailbox() {
      const emailAddress = optionalValue(tempRecoveryEmail);
      if (!emailAddress) {
        setError({
          code: "TEMP_MAILBOX_RECOVERY_EMAIL_REQUIRED",
          user_message: "Enter the temporary mailbox address to recover.",
          correlation_id: "desktop-validation",
        });
        return;
      }

      setBusy(true);
      try {
        const hostId = await bundledCoreClient.getHostId();
        const { result } = await bundledCoreClient.recoverMailbox({
          emailAddress,
          providerTypeKey: optionalValue(tempRecoveryProviderType) ?? undefined,
          hostId,
        });
        if (!result.recovered || !result.session) {
          setError({
            code: "TEMP_MAILBOX_RECOVERY_NOT_AVAILABLE",
            user_message:
              result.detail ??
              "The selected provider could not recover this mailbox from its server-side state.",
            correlation_id: "core-http-recovery",
          });
          return;
        }
        applyCoreTemporaryState(await loadCoreTemporaryState());
        setSelectedTempMailboxId(result.session.id);
        setTempRecoveryEmail("");
        showStatusToast(
          `Recovered ${result.session.emailAddress} with ${result.strategy.replace(/_/g, " ")}.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function readTempMailboxAuthenticationLink() {
      const mailbox = selectedTemporaryMailbox();
      if (!mailbox) return;

      setBusy(true);
      try {
        const { authLink } = await bundledCoreClient.readAuthenticationLink(mailbox.id);
        setLastAuthenticationLink(authLink ?? null);
        if (!authLink) {
          setError({
            code: "TEMP_MAILBOX_AUTH_LINK_NOT_FOUND",
            user_message: "No authentication link has been observed for this mailbox yet.",
            correlation_id: "core-http-auth-link",
          });
          return;
        }
        showStatusToast(`Found an authentication link for ${mailbox.email_address}.`);
        setError(null);
      } catch (caught: unknown) {
        setLastAuthenticationLink(null);
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function openLastTempMailboxAuthenticationLink() {
      if (!lastAuthenticationLink) return;
      try {
        await openUrl(lastAuthenticationLink.url);
        showStatusToast("Opened the temporary-mailbox authentication link.");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      }
    }
  async function updateTempMailboxSession() {
      const mailbox = selectedTemporaryMailbox();
      if (!mailbox) return;

      setBusy(true);
      try {
        await bundledCoreClient.updateMailbox({
          sessionId: mailbox.id,
          fromContains: tempMailboxFromContains,
        });
        applyCoreTemporaryState(await loadCoreTemporaryState());
        showStatusToast(
          tempMailboxFromContains.trim()
            ? `Updated sender filter for ${mailbox.email_address}.`
            : `Cleared sender filter for ${mailbox.email_address}.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function reportTempMailboxOutcome(success: boolean) {
      const mailbox = selectedTemporaryMailbox();
      if (!mailbox) return;
      const failureReason = optionalValue(tempOutcomeFailureReason);
      if (!success && !failureReason) {
        setError({
          code: "TEMP_MAILBOX_FAILURE_REASON_REQUIRED",
          user_message: "Enter a failure reason before reporting a failed mailbox outcome.",
          correlation_id: "desktop-validation",
        });
        return;
      }

      setBusy(true);
      try {
        const { result } = await bundledCoreClient.reportMailboxOutcome({
          sessionId: mailbox.id,
          success,
          failureReason: failureReason ?? undefined,
          source: "desktop-ui",
          businessFlow: "temporary-mailbox",
          retryLayer: "attempt",
        });
        showStatusToast(
          `Reported ${success ? "successful" : "failed"} outcome; provider health is ${result.healthScore.toFixed(2)}.`,
        );
        if (success) setTempOutcomeFailureReason("");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function releaseTempMailbox() {
      const mailbox = selectedTemporaryMailbox();
      if (!mailbox) return;
      if (!window.confirm(`Release ${mailbox.email_address} and stop receiving new messages?`)) {
        return;
      }

      setBusy(true);
      try {
        const { result } = await bundledCoreClient.releaseMailbox({
          sessionId: mailbox.id,
          reason: "desktop-user-release",
        });
        applyCoreTemporaryState(await loadCoreTemporaryState());
        if (waitingMailboxId === mailbox.id) setWaitingMailboxId(null);
        showStatusToast(
          result.released
            ? `Released ${mailbox.email_address} at the provider.`
            : `Closed ${mailbox.email_address} locally; provider release was unavailable.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function sendTempMailboxMessage() {
      const mailbox = selectedTemporaryMailbox();
      if (!mailbox) return;
      const toEmailAddress = optionalValue(tempSendTo);
      const subject = optionalValue(tempSendSubject);
      if (!toEmailAddress || !subject) {
        setError({
          code: "TEMP_MAILBOX_SEND_FIELDS_REQUIRED",
          user_message: "Enter both a recipient address and subject before sending.",
          correlation_id: "desktop-validation",
        });
        return;
      }
      if (mailbox.lifecycle_state !== "active") {
        setError({
          code: "TEMP_MAILBOX_NOT_ACTIVE",
          user_message: "Only an active temporary mailbox can send mail.",
          correlation_id: "desktop-validation",
        });
        return;
      }

      setBusy(true);
      try {
        const { result } = await bundledCoreClient.sendMailboxMessage({
          sessionId: mailbox.id,
          toEmailAddress,
          subject,
          textBody: optionalValue(tempSendBody) ?? undefined,
        });
        setTempSendSubject("");
        setTempSendBody("");
        showStatusToast(
          `Sent from ${result.senderEmailAddress} to ${result.recipientEmailAddress} via ${result.deliveryMode}.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function pollWaitingMailbox(
      tempMailboxId: string,
      isCurrent: () => boolean,
    ): Promise<boolean> {
      try {
        const { result: refresh, coreState } = await refreshCoreMailboxes(
          { sessionId: tempMailboxId },
          isCurrent,
        );
        if (!isCurrent()) {
          return false;
        }
        const { code } = await bundledCoreClient.readVerificationCode(tempMailboxId);
        const mailbox = coreState.mailboxes.find((item) => item.id === tempMailboxId);
        const mailboxStillReceives =
          mailbox?.lifecycle_state === "active";

        if (!isCurrent()) {
          return false;
        }

        setLastRefresh(refresh);

        if (code && mailbox) {
          const observedMessage = coreObservedMessagesRef.current.get(code.observedMessageId);
          const detectedCode = temporaryVerificationCodeView(code, mailbox, observedMessage);
          setRecentCodes((current) =>
            mergeByIdentity([detectedCode], current, (item) => item.id),
          );
          setStatusMessage(
            `Detected verification code for ${detectedCode.received_address}.`,
          );
          setError(null);
          return true;
        }

        if (!mailboxStillReceives) {
          setStatusMessage("Waiting stopped because the temporary mailbox is no longer active.");
          return true;
        }

        setStatusMessage("Waiting for verification code...");
        setError(null);
        return false;
      } catch (caught: unknown) {
        if (isCurrent()) {
          setError(asErrorDto(caught));
        }
        return false;
      }
    }
  return {
    createTempMailbox, refreshAnonymousMailOnce, refreshAnonymousMail, refreshMailbox, recoverTempMailbox, readTempMailboxAuthenticationLink, openLastTempMailboxAuthenticationLink, updateTempMailboxSession,
    reportTempMailboxOutcome, releaseTempMailbox, sendTempMailboxMessage, pollWaitingMailbox,
  };
}

export type UseTemporaryMailboxControllerResult = ReturnType<typeof useTemporaryMailboxController>;
