import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type SenderAvatarDto } from "../components/SenderAvatarIcon";
import { senderAvatarMapKey } from "../mail/senderAvatar";
import { asErrorDto } from "./appDomain";
import type { AppState } from "./useAppState";
import type { UseMailProjectionResult } from "./useMailProjection";
import type { UseMailSourceControllerResult } from "./useMailSourceController";

type Dependencies = Pick<
  UseMailProjectionResult,
  | "paginatedDisplayedMailMessages"
  | "displayedMailConversations"
  | "displayedMailMessages"
  | "paginatedDisplayedMailConversations"
> & Pick<UseMailSourceControllerResult, "normalImapAccounts">;

export function useSelectedMailView(appState: AppState, dependencies: Dependencies) {
  const {
    selectedMailMessageId, selectedMailConversationKey, selectedMessageDetail, avatarSettings, senderAvatarsBySender, setSenderAvatarsBySender, setError,
  } = appState;
  const {
    paginatedDisplayedMailMessages, displayedMailConversations, displayedMailMessages, normalImapAccounts, paginatedDisplayedMailConversations,
  } = dependencies;
  const selectedVisibleMailMessage =
      selectedMailMessageId === null
        ? null
        : (paginatedDisplayedMailMessages.find((message) => message.message_id === selectedMailMessageId) ??
          null);
  const selectedMailConversation =
      selectedMailConversationKey === null
        ? selectedMailMessageId === null
          ? null
          : (displayedMailConversations.find((conversation) =>
              conversation.messages.some((message) => message.message_id === selectedMailMessageId),
            ) ?? null)
        : (displayedMailConversations.find(
            (conversation) => conversation.key === selectedMailConversationKey,
          ) ?? null);
  const selectedMailConversationMessages = selectedMailConversation?.messages ?? [];
  const selectedDetailIsVisible =
      selectedMessageDetail !== null &&
      selectedMessageDetail.message_id === selectedMailMessageId &&
      paginatedDisplayedMailMessages.some((message) => message.message_id === selectedMessageDetail.message_id);
  const selectedMailMessage = selectedDetailIsVisible
      ? selectedMessageDetail
      : selectedVisibleMailMessage;
  const senderAvatarRequestKey = [
      ...displayedMailMessages.slice(0, 60).map((message) => senderAvatarMapKey(message.from_address)),
      selectedMailMessage ? senderAvatarMapKey(selectedMailMessage.from_address) : "",
      avatarSettings.remote_enabled ? "remote:on" : "remote:off",
      avatarSettings.bimi_enabled ? "bimi:on" : "bimi:off",
      avatarSettings.favicon_enabled ? "favicon:on" : "favicon:off",
      avatarSettings.auth_enabled ? "auth:on" : "auth:off",
    ].join("|");
  function senderAvatarFor(sender: string): SenderAvatarDto | null {
      return senderAvatarsBySender[senderAvatarMapKey(sender)] ?? null;
    }
  useEffect(() => {
      const senders = Array.from(
        new Set(
          [
            ...displayedMailMessages.slice(0, 60).map((message) => message.from_address),
            selectedMailMessage?.from_address ?? "",
          ].filter((sender) => sender.trim().length > 0),
        ),
      );
      if (senders.length === 0) {
        return;
      }

      let cancelled = false;
      invoke<SenderAvatarDto[]>("avatar_resolve_senders", {
        request: { senders },
      })
        .then((avatars) => {
          if (cancelled) {
            return;
          }
          setSenderAvatarsBySender((current) => {
            const next = { ...current };
            for (const avatar of avatars) {
              next[senderAvatarMapKey(avatar.sender)] = avatar;
            }
            return next;
          });
        })
        .catch((caught: unknown) => {
          if (!cancelled) {
            setError(asErrorDto(caught));
          }
        });

      return () => {
        cancelled = true;
      };
    }, [senderAvatarRequestKey]);
  const selectedReplyAccountId =
      selectedVisibleMailMessage?.sourceId.startsWith("account:") === true
        ? selectedVisibleMailMessage.sourceId.slice("account:".length)
        : null;
  const selectedReplyAccount =
      selectedReplyAccountId === null
        ? null
        : (normalImapAccounts.find((account) => account.id === selectedReplyAccountId) ?? null);
  const canDraftReply =
      selectedVisibleMailMessage !== null &&
      selectedVisibleMailMessage.sourceId.startsWith("account:");
  const selectedReplyAccountCanSend =
      selectedReplyAccountId === null || selectedReplyAccount?.send_status === "enabled";
  const selectedMailMessageIndex =
      selectedMailConversation === null
        ? -1
        : paginatedDisplayedMailConversations.findIndex(
            (conversation) => conversation.key === selectedMailConversation.key,
          );
  const selectedMessageToAddress =
      selectedVisibleMailMessage?.received_address ?? selectedMailMessage?.received_address ?? "";
  const canGoPreviousMailMessage = selectedMailMessageIndex > 0;
  const canGoNextMailMessage =
      selectedMailMessageIndex >= 0 && selectedMailMessageIndex < paginatedDisplayedMailConversations.length - 1;
  const selectedMailMessageIsRead = selectedMailMessage?.is_read ?? false;
  return {
    selectedVisibleMailMessage, selectedMailConversation, selectedMailConversationMessages, selectedMailMessage, senderAvatarFor, canDraftReply, selectedReplyAccountCanSend, selectedMailMessageIndex,
    selectedMessageToAddress, canGoPreviousMailMessage, canGoNextMailMessage, selectedMailMessageIsRead,
  };
}

export type UseSelectedMailViewResult = ReturnType<typeof useSelectedMailView>;
