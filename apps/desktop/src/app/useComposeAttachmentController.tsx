import type { ChangeEvent, FormEvent } from "react";
import { useEffect } from "react";
import { formatComposeScheduleDate } from "../compose/composeDateUtils";
import { COMPOSE_DRAFT_AUTOSAVE_MS } from "./appConfig";
import type { AppState } from "./useAppState";

type Dependencies = {
  rememberModalReturnFocus: () => void;
  readComposeDraftSnapshot: () => import("./appTypes").ComposeDraftSnapshot | null;
  restoreComposeDraftSnapshot: (snapshot: import("./appTypes").ComposeDraftSnapshot) => void;
  saveComposeDraftNow: () => Promise<void>;
};

export function useComposeAttachmentController(appState: AppState, dependencies: Dependencies) {
  const {
    setComposeAttachments, setStatusMessage, setComposeScheduleCustomValue, setComposeSchedulePreset, setComposeScheduledAtIso, setComposeScheduleSendOpen, setComposeEncryptionMenuOpen, setComposeBottomMoreOpen,
    setComposeEncryptionModalOpen, composeEncryptionPassword, setComposeExternalEncryption, setComposeExpirationEnabled, setComposeExpirationModalOpen, composeExpirationDate, composeExpirationTime, composePopoverOpen,
    composeDraftHydratedRef, setComposeDraftDirty, composeDraftRevisionRef, selectedNormalAccountId, sendTargetAddress, composeCcAddress, composeBccAddress, composeRecipientDrafts,
    sendSubject, sendBodyText, sendBodyHtml, composePlainTextMode, composeAttachPublicKey, composeRequestReadReceipt, composeExpirationEnabled, composeExternalEncryption,
    composeScheduledAtIso, composeDraftDirty,
  } = appState;
  const {
    rememberModalReturnFocus, readComposeDraftSnapshot, restoreComposeDraftSnapshot, saveComposeDraftNow,
  } = dependencies;
  function handleComposeAttachmentFiles(event: ChangeEvent<HTMLInputElement>) {
      const files = Array.from(event.currentTarget.files ?? []);
      if (files.length === 0) {
        return;
      }
      setComposeAttachments((current) => [
        ...current,
        ...files.map((file) => ({
          id: `${file.name}:${file.size}:${file.lastModified}`,
          name: file.name,
          size: file.size,
        })),
      ]);
      setStatusMessage("Attachments are staged in the composer; SMTP attachment delivery still needs backend MIME support.");
      event.currentTarget.value = "";
    }
  function applyComposeCustomScheduleValue(value: string) {
      setComposeScheduleCustomValue(value);
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return;
      }
      setComposeSchedulePreset("custom");
      setComposeScheduledAtIso(date.toISOString());
      setStatusMessage(`已选择定时发送时间：${formatComposeScheduleDate(date)}。`);
    }
  function clearComposeSchedule() {
      setComposeSchedulePreset(null);
      setComposeScheduledAtIso(null);
      setComposeScheduleSendOpen(false);
      setStatusMessage("已切换为直接发送。");
    }
  function openComposeEncryptionModal() {
      rememberModalReturnFocus();
      setComposeEncryptionMenuOpen(false);
      setComposeBottomMoreOpen(false);
      setComposeScheduleSendOpen(false);
      setComposeEncryptionModalOpen(true);
    }
  function submitComposeEncryptionModal(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (composeEncryptionPassword.trim().length < 8) {
        setStatusMessage("Encryption password must be at least 8 characters.");
        return;
      }
      setComposeExternalEncryption(true);
      setComposeExpirationEnabled(true);
      setComposeEncryptionModalOpen(false);
      setStatusMessage("已为此草稿保存加密预览设置；当前不会发送真实加密邮件。");
    }
  function submitComposeExpirationModal(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setComposeExpirationEnabled(true);
      setComposeExpirationModalOpen(false);
      setComposeBottomMoreOpen(false);
      setStatusMessage(`Expiration set for ${composeExpirationDate} ${composeExpirationTime}.`);
    }
  function copyComposeEncryptionPassword() {
      void navigator.clipboard?.writeText(composeEncryptionPassword).catch(() => undefined);
      setStatusMessage("Encryption password copied.");
    }
  useEffect(() => {
      if (!composePopoverOpen || composeDraftHydratedRef.current) {
        return;
      }
      composeDraftHydratedRef.current = true;
      const snapshot = readComposeDraftSnapshot();
      if (snapshot) {
        restoreComposeDraftSnapshot(snapshot);
        setComposeDraftDirty(false);
      }
    }, [composePopoverOpen]);
  useEffect(() => {
      if (!composePopoverOpen || !composeDraftHydratedRef.current) {
        return;
      }
      composeDraftRevisionRef.current += 1;
      setComposeDraftDirty(true);
    }, [
      selectedNormalAccountId,
      sendTargetAddress,
      composeCcAddress,
      composeBccAddress,
      composeRecipientDrafts,
      sendSubject,
      sendBodyText,
      sendBodyHtml,
      composePlainTextMode,
      composeAttachPublicKey,
      composeRequestReadReceipt,
      composeExpirationEnabled,
      composeExternalEncryption,
      composeScheduledAtIso,
      composePopoverOpen,
    ]);
  useEffect(() => {
      if (!composePopoverOpen || !composeDraftDirty) {
        return;
      }
      const timer = window.setTimeout(() => {
        void saveComposeDraftNow();
      }, COMPOSE_DRAFT_AUTOSAVE_MS);
      return () => window.clearTimeout(timer);
    }, [
      selectedNormalAccountId,
      sendTargetAddress,
      composeCcAddress,
      composeBccAddress,
      composeRecipientDrafts,
      sendSubject,
      sendBodyText,
      sendBodyHtml,
      composePlainTextMode,
      composeAttachPublicKey,
      composeRequestReadReceipt,
      composeExpirationEnabled,
      composeExternalEncryption,
      composeScheduledAtIso,
      composeDraftDirty,
      composePopoverOpen,
    ]);
  return {
    handleComposeAttachmentFiles, applyComposeCustomScheduleValue, clearComposeSchedule, openComposeEncryptionModal, submitComposeEncryptionModal, submitComposeExpirationModal, copyComposeEncryptionPassword,
  };
}

export type UseComposeAttachmentControllerResult = ReturnType<typeof useComposeAttachmentController>;
