import { useEffect, useMemo } from "react";
import { toAccountDto } from "../api/mailAccountClient";
import { useEventCallback } from "../hooks/useEventCallback";
import { temporaryMailboxViewFromSession } from "../mail/temporaryMailboxAdapter";
import { createNonOverlappingAsyncRunner } from "../utils/asyncTask";
import { asErrorDto, mergeByIdentity } from "./appDomain";
import { bundledCoreClient, mailAccountClient, mailMessageClient } from "./appRuntime";
import type { TempMailboxDto, PromoteTempMailboxDto } from "./appTypes";
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
        const promotedResponse = await bundledCoreClient.promoteMailbox(mailbox.id, {
          confirmLifecycleAck: true,
        });
        const promotedAccountDto = toAccountDto(promotedResponse.account);
        const result: PromoteTempMailboxDto = {
          account: promotedAccountDto,
          mailbox: temporaryMailboxViewFromSession(promotedResponse.session),
        };
        const [coreState, anonymous, accounts, codes] = await Promise.all([
          loadCoreTemporaryState(),
          mailMessageClient.listAnonymousMessages(true),
          mailAccountClient.listNormalAccounts(),
          mailMessageClient.listRecentVerifications(null, 100),
        ]);
        const promoted = await loadPromotedMessages(promotedAccountDto.id);
        setLastPromotion(result);
        setTempMailboxes(coreState.mailboxes);
        setAnonymousMessages(anonymous);
        canonicalNormalAccountIdsRef.current = new Set(accounts.map((account) => account.id));
        setNormalAccounts(accounts);
        setRecentCodes(mergeByIdentity(codes, coreState.codes, (code) => code.id));
        setPromotedMessagesByAccount((current) => ({ ...current, [promotedAccountDto.id]: promoted }));
        setMailSourceId(`promoted:${promotedAccountDto.id}`);
        setStatusMessage(`Promoted ${promotedAccountDto.display_name} without moving message history.`);
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
