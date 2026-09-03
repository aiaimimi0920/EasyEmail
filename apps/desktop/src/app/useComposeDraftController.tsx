import { invoke } from "@tauri-apps/api/core";
import { parseComposeAddressList } from "../compose/composeData";
import { formatComposeLocalDateTimeInput } from "../compose/composeDateUtils";
import { sanitizeComposeHtml } from "../compose/composeHtmlSanitizer";
import { COMPOSE_DRAFT_STORAGE_KEY } from "./appConfig";
import { asErrorDto } from "./appDomain";
import type { MessageLocalActionDto, LocalDraftSaveDto, ComposeDraftSnapshot } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  composeRichBodyHtmlToPlainText: (editor: HTMLElement) => string;
  syncComposeRichBodyState: () => void;
  isCanonicalNormalAccountId: (accountId: string) => boolean;
  loadNormalMessages: (accountId: string, isCurrent?: () => boolean) => Promise<import("./appTypes").AnonymousMessageDto[]>;
  setDraftBodyText: (text: string) => void;
};

export function useComposeDraftController(appState: AppState, dependencies: Dependencies) {
  const {
    composeBodyEditorRef, sendBodyHtml, sendBodyText, composePersistedDraftIdRef, selectedNormalAccountId, sendTargetAddress, composeCcAddress, composeBccAddress,
    composeRecipientDrafts, sendSubject, composePlainTextMode, composeAttachPublicKey, composeRequestReadReceipt, composeExpirationEnabled, composeExternalEncryption, composeScheduledAtIso,
    composeDraftRevisionRef, setComposePersistedDraftId, setSelectedNormalAccountId, setSendTargetAddress, setComposeCcAddress, setComposeBccAddress, setComposeRecipientDrafts, setComposeCcOpen,
    setComposeBccOpen, setSendSubject, setSendBodyText, setSendBodyHtml, setComposePlainTextMode, setComposeAttachPublicKey, setComposeRequestReadReceipt, setComposeExpirationEnabled,
    setComposeExternalEncryption, setComposeScheduledAtIso, setComposeSchedulePreset, setComposeScheduleCustomValue, setComposeDraftSavedAt, setComposeDraftDirty, setStatusMessage, composePersistedDraftId,
    setComposeAttachments,
  } = appState;
  const {
    composeRichBodyHtmlToPlainText, syncComposeRichBodyState, isCanonicalNormalAccountId, loadNormalMessages, setDraftBodyText,
  } = dependencies;
  function escapeComposePlainTextToHtml(text: string): string {
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/\r?\n/g, "<br>");
    }
  function composeDraftHasUserContent(snapshot: ComposeDraftSnapshot) {
      return (
        snapshot.to.trim().length > 0 ||
        snapshot.cc.trim().length > 0 ||
        snapshot.bcc.trim().length > 0 ||
        snapshot.recipientDrafts.to.trim().length > 0 ||
        snapshot.recipientDrafts.cc.trim().length > 0 ||
        snapshot.recipientDrafts.bcc.trim().length > 0 ||
        snapshot.subject.trim().length > 0 ||
        snapshot.bodyText.trim().length > 0 ||
        snapshot.bodyHtml.replace(/<br\s*\/?>|&nbsp;|\s|<[^>]+>/gi, "").trim().length > 0
      );
    }
  function buildComposeDraftSnapshot(savedAt = new Date().toISOString()): ComposeDraftSnapshot {
      const editor = composeBodyEditorRef.current;
      const currentBodyHtml = editor ? editor.innerHTML : sendBodyHtml;
      const currentBodyText = editor ? composeRichBodyHtmlToPlainText(editor) : sendBodyText;
      const sanitizedBodyHtml = sanitizeComposeHtml(currentBodyHtml);
      return {
        persistedDraftId: composePersistedDraftIdRef.current,
        senderAccountId: selectedNormalAccountId,
        to: sendTargetAddress,
        cc: composeCcAddress,
        bcc: composeBccAddress,
        recipientDrafts: composeRecipientDrafts,
        subject: sendSubject,
        bodyText: currentBodyText,
        bodyHtml: sanitizedBodyHtml,
        plainTextMode: composePlainTextMode,
        attachPublicKey: composeAttachPublicKey,
        requestReadReceipt: composeRequestReadReceipt,
        expirationEnabled: composeExpirationEnabled,
        externalEncryption: composeExternalEncryption,
        scheduledAtIso: composeScheduledAtIso,
        savedAt,
      };
    }
  function restoreComposeDraftSnapshot(snapshot: ComposeDraftSnapshot) {
      const sanitizedBodyHtml = sanitizeComposeHtml(snapshot.bodyHtml || "");
      composeDraftRevisionRef.current += 1;
      composePersistedDraftIdRef.current = snapshot.persistedDraftId ?? null;
      setComposePersistedDraftId(snapshot.persistedDraftId ?? null);
      setSelectedNormalAccountId(snapshot.senderAccountId);
      setSendTargetAddress(snapshot.to);
      setComposeCcAddress(snapshot.cc);
      setComposeBccAddress(snapshot.bcc);
      setComposeRecipientDrafts(snapshot.recipientDrafts ?? { to: "", cc: "", bcc: "" });
      setComposeCcOpen(snapshot.cc.trim().length > 0);
      setComposeBccOpen(snapshot.bcc.trim().length > 0);
      setSendSubject(snapshot.subject);
      setSendBodyText(snapshot.bodyText);
      setSendBodyHtml(sanitizedBodyHtml);
      setComposePlainTextMode(snapshot.plainTextMode);
      setComposeAttachPublicKey(snapshot.attachPublicKey);
      setComposeRequestReadReceipt(snapshot.requestReadReceipt);
      setComposeExpirationEnabled(snapshot.expirationEnabled);
      setComposeExternalEncryption(snapshot.externalEncryption);
      setComposeScheduledAtIso(snapshot.scheduledAtIso);
      setComposeSchedulePreset(null);
      if (snapshot.scheduledAtIso) {
        const restoredScheduleDate = new Date(snapshot.scheduledAtIso);
        if (!Number.isNaN(restoredScheduleDate.getTime())) {
          setComposeScheduleCustomValue(formatComposeLocalDateTimeInput(restoredScheduleDate));
        }
      }
      setComposeDraftSavedAt(snapshot.savedAt);
      window.requestAnimationFrame(() => {
        const editor = composeBodyEditorRef.current;
        if (!editor) {
          return;
        }
        editor.innerHTML = sanitizedBodyHtml;
        syncComposeRichBodyState();
      });
    }
  async function saveComposeDraftNow() {
      const revision = ++composeDraftRevisionRef.current;
      const savedAt = new Date().toISOString();
      const snapshot = buildComposeDraftSnapshot(savedAt);
      window.localStorage.setItem(COMPOSE_DRAFT_STORAGE_KEY, JSON.stringify(snapshot));
      setComposeDraftSavedAt(savedAt);
      setComposeDraftDirty(false);

      if (!snapshot.senderAccountId || !composeDraftHasUserContent(snapshot)) {
        return;
      }
      if (isCanonicalNormalAccountId(snapshot.senderAccountId)) {
        setStatusMessage("Draft saved in this browser; canonical draft persistence becomes available in M4.");
        return;
      }

      try {
        const result = await invoke<LocalDraftSaveDto>("message_save_local_draft", {
          request: {
            draft_id: snapshot.persistedDraftId,
            account_id: snapshot.senderAccountId,
            target_address: snapshot.to,
            cc_addresses: parseComposeAddressList(
              [snapshot.cc, snapshot.recipientDrafts.cc].filter(Boolean).join(", "),
            ),
            bcc_addresses: parseComposeAddressList(
              [snapshot.bcc, snapshot.recipientDrafts.bcc].filter(Boolean).join(", "),
            ),
            subject: snapshot.subject,
            body_text: snapshot.bodyText,
            body_html: snapshot.bodyHtml,
          },
        });
        if (revision !== composeDraftRevisionRef.current) {
          return;
        }
        const persistedSnapshot = {
          ...snapshot,
          persistedDraftId: result.message_id,
          savedAt: result.saved_at,
        };
        composePersistedDraftIdRef.current = result.message_id;
        setComposePersistedDraftId(result.message_id);
        setComposeDraftSavedAt(result.saved_at);
        window.localStorage.setItem(COMPOSE_DRAFT_STORAGE_KEY, JSON.stringify(persistedSnapshot));
        await loadNormalMessages(
          snapshot.senderAccountId,
          () => revision === composeDraftRevisionRef.current,
        );
      } catch (caught: unknown) {
        if (revision !== composeDraftRevisionRef.current) {
          return;
        }
        const errorDto = asErrorDto(caught);
        setStatusMessage(`Draft could not be saved locally: ${errorDto.user_message}`);
      }
    }
  function readComposeDraftSnapshot(): ComposeDraftSnapshot | null {
      const raw = window.localStorage.getItem(COMPOSE_DRAFT_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      try {
        return JSON.parse(raw) as ComposeDraftSnapshot;
      } catch {
        window.localStorage.removeItem(COMPOSE_DRAFT_STORAGE_KEY);
        return null;
      }
    }
  function discardComposeDraft() {
      composeDraftRevisionRef.current += 1;
      const draftIdToDelete = composePersistedDraftId;
      const draftAccountId = selectedNormalAccountId;
      setSendTargetAddress("");
      setComposeCcAddress("");
      setComposeBccAddress("");
      setComposeRecipientDrafts({ to: "", cc: "", bcc: "" });
      setComposeCcOpen(false);
      setComposeBccOpen(false);
      setSendSubject("");
      setDraftBodyText("");
      setComposeAttachments([]);
      setComposePlainTextMode(false);
      setComposeAttachPublicKey(false);
      setComposeRequestReadReceipt(false);
      setComposeExpirationEnabled(false);
      setComposeExternalEncryption(false);
      setComposeSchedulePreset(null);
      setComposeScheduledAtIso(null);
      window.localStorage.removeItem(COMPOSE_DRAFT_STORAGE_KEY);
      setComposeDraftDirty(false);
      setComposeDraftSavedAt(null);
      composePersistedDraftIdRef.current = null;
      setComposePersistedDraftId(null);
      if (draftIdToDelete) {
        void invoke<MessageLocalActionDto>("message_delete_local_draft", {
          request: { draft_id: draftIdToDelete },
        }).then(() => {
          if (draftAccountId) {
            void loadNormalMessages(draftAccountId);
          }
        });
      }
      setStatusMessage("Draft deleted.");
    }
  return {
    escapeComposePlainTextToHtml, restoreComposeDraftSnapshot, saveComposeDraftNow, readComposeDraftSnapshot, discardComposeDraft,
  };
}

export type UseComposeDraftControllerResult = ReturnType<typeof useComposeDraftController>;
