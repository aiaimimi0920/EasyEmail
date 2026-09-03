import type { ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { preprocessContactAvatarFile } from "../avatar/contactAvatarImage";
import { type SenderAvatarDto } from "../components/SenderAvatarIcon";
import { senderAvatarMapKey } from "../mail/senderAvatar";
import { asErrorDto, optionalValue } from "./appDomain";
import { avatarSettingsClient, settingsClient } from "./appRuntime";
import type { AppState } from "./useAppState";

export function useAccountSettingsController(appState: AppState) {
  const {
    setBusy, serviceUrl, setSettings, setServiceUrl, setStatusMessage, setError, avatarSettings, setAvatarSettings,
    setSenderAvatarsBySender, setAvatarEditor, avatarEditor, avatarUploadSenderRef, avatarFileInputRef, apiToken, setEasyEmailHealth,
  } = appState;
  async function saveSettings() {
      setBusy(true);
      try {
        const result = await settingsClient.updateEasyEmailSettings({
          service_url: serviceUrl,
        });
        setSettings(result);
        setServiceUrl(result.service_url ?? "");
        setStatusMessage("EasyEmail service URL saved.");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function saveAvatarSettings(nextSettings = avatarSettings) {
      setBusy(true);
      try {
        const result = await avatarSettingsClient.updateAvatarSettings(nextSettings);
        setAvatarSettings(result);
        setSenderAvatarsBySender({});
        setStatusMessage("Sender avatar settings saved.");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function clearSenderAvatarCache(includeContacts = false) {
      setBusy(true);
      try {
        const result = await avatarSettingsClient.clearAvatarCache({
          include_contacts: includeContacts,
        });
        setSenderAvatarsBySender({});
        setStatusMessage(
          includeContacts
            ? `Cleared ${result.deleted_count} cached and contact avatar rows.`
            : `Cleared ${result.deleted_count} cached avatar rows.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  function openAvatarEditor(sender: string, target: HTMLElement) {
      const rect = target.getBoundingClientRect();
      const width = 264;
      const height = 180;
      const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
      const below = rect.bottom + 10;
      const top =
        below + height > window.innerHeight
          ? Math.max(12, rect.top - height - 10)
          : Math.max(12, below);
      setAvatarEditor({ sender, left, top });
    }
  function chooseAvatarEditorFile() {
      if (!avatarEditor) {
        return;
      }
      avatarUploadSenderRef.current = avatarEditor.sender;
      avatarFileInputRef.current?.click();
    }
  async function handleContactAvatarFile(event: ChangeEvent<HTMLInputElement>) {
      const file = event.currentTarget.files?.[0] ?? null;
      const uploadSender = avatarUploadSenderRef.current;
      event.currentTarget.value = "";
      if (!file || uploadSender === null) {
        avatarUploadSenderRef.current = null;
        return;
      }
      setBusy(true);
      try {
        const imageDataUrl = await preprocessContactAvatarFile(file);
        const avatar = await invoke<SenderAvatarDto>("avatar_set_contact", {
          request: { sender: uploadSender, image_data_url: imageDataUrl },
        });
        setSenderAvatarsBySender((current) => ({
          ...current,
          [senderAvatarMapKey(avatar.sender)]: avatar,
        }));
        setAvatarEditor(null);
        setStatusMessage(`Custom icon saved for ${avatar.display_name}.`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
        avatarUploadSenderRef.current = null;
      }
    }
  async function clearAvatarEditorContact() {
      if (!avatarEditor) {
        return;
      }
      const sender = avatarEditor.sender;
      setBusy(true);
      try {
        await invoke("avatar_clear_contact", {
          request: { sender },
        });
        setSenderAvatarsBySender((current) => {
          const next = { ...current };
          delete next[senderAvatarMapKey(sender)];
          return next;
        });
        setAvatarEditor(null);
        setStatusMessage("Custom sender icon cleared.");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function testConnection() {
      setBusy(true);
      try {
        const result = await settingsClient.testEasyEmailConnection({
          service_url: optionalValue(serviceUrl),
          api_token: optionalValue(apiToken),
        });
        setEasyEmailHealth(result);
        setStatusMessage("EasyEmail connection test completed.");
        setError(null);
      } catch (caught: unknown) {
        setEasyEmailHealth(null);
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  return {
    saveSettings, saveAvatarSettings, clearSenderAvatarCache, openAvatarEditor, chooseAvatarEditorFile, handleContactAvatarFile, clearAvatarEditorContact, testConnection,
  };
}

export type UseAccountSettingsControllerResult = ReturnType<typeof useAccountSettingsController>;
