import { useModalAccessibility, useNonModalLayerAccessibility } from "../hooks/useLayerAccessibility";
import type { AppState } from "./useAppState";

type Dependencies = {
  closeMailTaxonomyManager: () => void;
  closeContactModal: () => void;
  closeMailSearchOverlay: () => void;
  closeComposePopover: () => void;
};

export function useLayerController(appState: AppState, dependencies: Dependencies) {
  const {
    composeEncryptionModalOpen, composeExpirationModalOpen, composeLinkModalOpen, mailTaxonomyManagerKind, contactModalOpen, mailAccountPanelOpen, composeRecipientMenu, composeContactPickerField,
    composeScheduleSendOpen, composeBottomMoreOpen, composeEmojiPickerOpen, composeAlignmentMenuOpen, composeColorMenuOpen, composeFontSizeMenuOpen, composeFontMenuOpen, composeMoreMenuOpen,
    composeAiMoreMenuOpen, mailSearchOtherMenuOpen, mailListMoveMenuOpen, mailListLabelMenuOpen, mailListSnoozeMenuOpen, mailListSelectionMenuOpen, mailListBulkMenuOpen, mailListFilterMenuOpen,
    mailMoveMenuOpen, mailLabelMenuOpen, mailMessageMoreMenuOpen, mailSourceDropdownOpen, mailSearchOverlayOpen, avatarEditor, platformAccountMenuOpen, railCollapsed,
    railModePickerOpen, composePopoverOpen, setComposeEncryptionModalOpen, setComposeExpirationModalOpen, setComposeLinkModalOpen, setMailAccountPanelOpen, modalReturnFocusRef, setComposeRecipientMenu,
    setComposeContactPickerField, setComposeContactPickerPosition, setComposeScheduleSendOpen, setComposeBottomMoreOpen, setComposeEmojiPickerOpen, setComposeAlignmentMenuOpen, setComposeColorMenuOpen, setComposeFontSizeMenuOpen,
    setComposeFontMenuOpen, setComposeMoreMenuOpen, setComposeAiMoreMenuOpen, setMailSearchOtherMenuOpen, setMailListMoveMenuOpen, setMailListLabelMenuOpen, setMailListSnoozeMenuOpen, setMailListSelectionMenuOpen,
    setMailListBulkMenuOpen, setMailListFilterMenuOpen, setMailMoveMenuOpen, setMailLabelMenuOpen, setMailMessageMoreMenuOpen, setMailSourceDropdownOpen, setAvatarEditor, setPlatformAccountMenuOpen,
    setRailModePickerOpen, error, copyToast, statusToast, toastVersion, toastFadeTimerRef, toastRemoveTimerRef, setToastVisibleKey,
    setToastFading, setError, setCopyToast, setStatusToast,
  } = appState;
  const {
    closeMailTaxonomyManager, closeContactModal, closeMailSearchOverlay, closeComposePopover,
  } = dependencies;
  const activeModalId = composeEncryptionModalOpen
      ? "compose-encryption"
      : composeExpirationModalOpen
        ? "compose-expiration"
        : composeLinkModalOpen
          ? "compose-link"
          : mailTaxonomyManagerKind
            ? "mail-taxonomy"
            : contactModalOpen
              ? "contact"
              : mailAccountPanelOpen
                ? "mail-account"
                : null;
  const activeNonModalLayerId = activeModalId
      ? null
      : (
          [
            [composeRecipientMenu !== null, "compose-recipient"],
            [composeContactPickerField !== null, "compose-contact-picker"],
            [composeScheduleSendOpen, "compose-schedule"],
            [composeBottomMoreOpen, "compose-bottom-more"],
            [composeEmojiPickerOpen, "compose-emoji"],
            [composeAlignmentMenuOpen, "compose-alignment"],
            [composeColorMenuOpen, "compose-color"],
            [composeFontSizeMenuOpen, "compose-font-size"],
            [composeFontMenuOpen, "compose-font"],
            [composeMoreMenuOpen, "compose-more"],
            [composeAiMoreMenuOpen, "compose-ai-more"],
            [mailSearchOtherMenuOpen, "mail-search-other"],
            [mailListMoveMenuOpen, "mail-list-move"],
            [mailListLabelMenuOpen, "mail-list-label"],
            [mailListSnoozeMenuOpen, "mail-list-snooze"],
            [mailListSelectionMenuOpen, "mail-list-selection"],
            [mailListBulkMenuOpen, "mail-list-more"],
            [mailListFilterMenuOpen, "mail-list-filter"],
            [mailMoveMenuOpen, "mail-message-move"],
            [mailLabelMenuOpen, "mail-message-label"],
            [mailMessageMoreMenuOpen, "mail-message-more"],
            [mailSourceDropdownOpen, "mail-source"],
            [mailSearchOverlayOpen, "mail-search"],
            [avatarEditor !== null, "avatar-editor"],
            [platformAccountMenuOpen && !railCollapsed, "platform-account"],
            [railModePickerOpen && railCollapsed, "rail-mode"],
            [composePopoverOpen, "compose-popover"],
          ] as const
        ).find(([isOpen]) => isOpen)?.[1] ?? null;
  useModalAccessibility(
      activeModalId,
      () => {
        switch (activeModalId) {
          case "compose-encryption":
            setComposeEncryptionModalOpen(false);
            break;
          case "compose-expiration":
            setComposeExpirationModalOpen(false);
            break;
          case "compose-link":
            setComposeLinkModalOpen(false);
            break;
          case "mail-taxonomy":
            closeMailTaxonomyManager();
            break;
          case "contact":
            closeContactModal();
            break;
          case "mail-account":
            setMailAccountPanelOpen(false);
            break;
          default:
            break;
        }
      },
      modalReturnFocusRef,
    );
  useNonModalLayerAccessibility(activeNonModalLayerId, () => {
      switch (activeNonModalLayerId) {
        case "compose-recipient":
          setComposeRecipientMenu(null);
          break;
        case "compose-contact-picker":
          setComposeContactPickerField(null);
          setComposeContactPickerPosition(null);
          break;
        case "compose-schedule":
          setComposeScheduleSendOpen(false);
          break;
        case "compose-bottom-more":
          setComposeBottomMoreOpen(false);
          break;
        case "compose-emoji":
          setComposeEmojiPickerOpen(false);
          break;
        case "compose-alignment":
          setComposeAlignmentMenuOpen(false);
          break;
        case "compose-color":
          setComposeColorMenuOpen(false);
          break;
        case "compose-font-size":
          setComposeFontSizeMenuOpen(false);
          break;
        case "compose-font":
          setComposeFontMenuOpen(false);
          break;
        case "compose-more":
          setComposeMoreMenuOpen(false);
          break;
        case "compose-ai-more":
          setComposeAiMoreMenuOpen(false);
          break;
        case "mail-search-other":
          setMailSearchOtherMenuOpen(false);
          break;
        case "mail-list-move":
          setMailListMoveMenuOpen(false);
          break;
        case "mail-list-label":
          setMailListLabelMenuOpen(false);
          break;
        case "mail-list-snooze":
          setMailListSnoozeMenuOpen(false);
          break;
        case "mail-list-selection":
          setMailListSelectionMenuOpen(false);
          break;
        case "mail-list-more":
          setMailListBulkMenuOpen(false);
          break;
        case "mail-list-filter":
          setMailListFilterMenuOpen(false);
          break;
        case "mail-message-move":
          setMailMoveMenuOpen(false);
          break;
        case "mail-message-label":
          setMailLabelMenuOpen(false);
          break;
        case "mail-message-more":
          setMailMessageMoreMenuOpen(false);
          break;
        case "mail-source":
          setMailSourceDropdownOpen(false);
          break;
        case "mail-search":
          closeMailSearchOverlay();
          break;
        case "avatar-editor":
          setAvatarEditor(null);
          break;
        case "platform-account":
          setPlatformAccountMenuOpen(false);
          break;
        case "rail-mode":
          setRailModePickerOpen(false);
          break;
        case "compose-popover":
          closeComposePopover();
          break;
        default:
          break;
      }
    }, activeNonModalLayerId !== "compose-popover");
  const toastMessage = error?.user_message ?? copyToast ?? statusToast;
  const toastTone: "error" | "copy" | "status" = error ? "error" : copyToast ? "copy" : "status";
  const toastKey = toastMessage
      ? `${toastTone}:${error?.correlation_id ?? toastVersion}:${toastMessage}`
      : null;
  function rememberModalReturnFocus() {
      modalReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  function clearToastLifecycleTimers() {
      if (toastFadeTimerRef.current !== null) {
        window.clearTimeout(toastFadeTimerRef.current);
        toastFadeTimerRef.current = null;
      }
      if (toastRemoveTimerRef.current !== null) {
        window.clearTimeout(toastRemoveTimerRef.current);
        toastRemoveTimerRef.current = null;
      }
    }
  function dismissCurrentToast() {
      clearToastLifecycleTimers();
      setToastVisibleKey(null);
      setToastFading(false);
      if (error) {
        setError(null);
      } else if (copyToast) {
        setCopyToast(null);
      } else {
        setStatusToast(null);
      }
    }
  return {
    toastMessage, toastTone, toastKey, rememberModalReturnFocus, clearToastLifecycleTimers, dismissCurrentToast,
  };
}

export type UseLayerControllerResult = ReturnType<typeof useLayerController>;
