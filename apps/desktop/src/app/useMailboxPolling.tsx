import { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type VerificationCodeDto } from "../mail/mailSearch";
import { useEventCallback } from "../hooks/useEventCallback";
import { createNonOverlappingAsyncRunner } from "../utils/asyncTask";
import { asErrorDto, mergeByIdentity } from "./appDomain";
import { mailAccountClient } from "./appRuntime";
import type { TempMailboxDto, AnonymousMessageDto, PromoteTempMailboxDto } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  pollWaitingMailbox: (tempMailboxId: string, isCurrent: () => boolean) => Promise<boolean>;
  loadCoreTemporaryState: () => Promise<import("./appTypes").CoreTemporaryState>;
  loadPromotedMessages: (accountId: string) => Promise<import("./appTypes").AnonymousMessageDto[]>;
};

export function useMailboxPolling(appState: AppState, dependencies: Dependencies) {
  const {
    setWaitingMailboxId, waitingMailboxId, setBusy, setLastPromotion, setTempMailboxes, setAnonymousMessages, canonicalNormalAccountIdsRef, setNormalAccounts,
    setRecentCodes, setPromotedMessagesByAccount, setMailSourceId, setStatusMessage, setError,
  } = appState;
  const {
    pollWaitingMailbox, loadCoreTemporaryState, loadPromotedMessages,
  } = dependencies;
  const pollWaitingMailboxEvent = useEventCallback(pollWaitingMailbox);
  const runWaitingMailboxPoll = useMemo(
      () =>
        createNonOverlappingAsyncRunner(
          async (tempMailboxId: string, isCurrent: () => boolean) => {
            const shouldStop = await pollWaitingMailboxEvent(tempMailboxId, isCurrent);
            if (isCurrent() && shouldStop) {
              setWaitingMailboxId(null);
            }
          },
        ),
      [pollWaitingMailboxEvent],
    );
  useEffect(() => {
      if (!waitingMailboxId) {
        return;
      }

      let cancelled = false;
      const runPoll = () => {
        void runWaitingMailboxPoll(waitingMailboxId, () => !cancelled);
      };

      runPoll();
      const intervalId = window.setInterval(runPoll, 5000);

      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
      };
    }, [waitingMailboxId, runWaitingMailboxPoll]);
  async function promoteMailbox(mailbox: TempMailboxDto) {
      const lifecycleWarning =
        mailbox.lifecycle_state === "expired" || mailbox.lifecycle_state === "history_only"
          ? " This mailbox is expired/history-only; promotion will keep readable history but will not restore receiving."
          : "";
      const confirmed = window.confirm(
        `Promote ${mailbox.email_address} into a normal account? Promotion does not extend the provider lifetime and does not move or copy messages.${lifecycleWarning}`,
      );
      if (!confirmed) {
        return;
      }

      setBusy(true);
      try {
        const result = await invoke<PromoteTempMailboxDto>("temp_upgrade_mailbox", {
          request: {
            temp_mailbox_id: mailbox.id,
            confirm_lifecycle_ack: true,
          },
        });
        const [coreState, anonymous, accounts, codes] = await Promise.all([
          loadCoreTemporaryState(),
          invoke<AnonymousMessageDto[]>("message_list", {
            request: { scope: "anonymous", account_id: null, include_archived: true },
          }),
          mailAccountClient.listNormalAccounts(),
          invoke<VerificationCodeDto[]>("verification_list_recent", {
            request: { temp_mailbox_id: null, limit: 100 },
          }),
        ]);
        const promoted = await loadPromotedMessages(result.account.id);
        setLastPromotion(result);
        setTempMailboxes(coreState.mailboxes);
        setAnonymousMessages(
          mergeByIdentity(coreState.messages, anonymous, (message) => message.message_id),
        );
        canonicalNormalAccountIdsRef.current = new Set(accounts.map((account) => account.id));
        setNormalAccounts(accounts);
        setRecentCodes(mergeByIdentity(coreState.codes, codes, (code) => code.id));
        setPromotedMessagesByAccount((current) => ({ ...current, [result.account.id]: promoted }));
        setMailSourceId(`promoted:${result.account.id}`);
        setStatusMessage(`Promoted ${result.account.display_name} without moving message history.`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  return {
    promoteMailbox,
  };
}

export type UseMailboxPollingResult = ReturnType<typeof useMailboxPolling>;
