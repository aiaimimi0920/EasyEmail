import { openUrl } from "@tauri-apps/plugin-opener";
import {
  COMPOSE_COLOR_SWATCHES,
  COMPOSE_EMOJI_CATEGORIES,
  COMPOSE_FONT_OPTIONS,
  COMPOSE_FONT_SIZE_OPTIONS,
  composeFontCss,
  parseComposeAddressList,
  type ComposeRecipientField,
} from "../compose/composeData";
import {
  formatComposeDraftSavedAt,
  formatComposeScheduleDate,
} from "../compose/composeDateUtils";
import { extractEmailAddress, displayNameFromAddress, normalizeMailToken } from "../mail/mailSelectors";
import { formatMailListTime } from "../mail/mailDateUtils";
import { renderLinkedMessageText } from "../mail/messageLinkRenderer";
import {
  MailConversationCard,
  renderMailListStateRow,
} from "../components/MailConversationCard";
import {
  ClearFormatIcon,
  EasyEmailAppIcon,
  MailListToolbarIcon,
  RailChevronIcon,
  RailIcon,
  SearchMagnifierIcon,
} from "../components/AppIcons";
import { SenderAvatarIcon } from "../components/SenderAvatarIcon";
import {
  MAIL_RAIL_ITEMS,
  MAIL_SEARCH_PRIMARY_SCOPES, TOAST_FADE_MS, TOAST_VISIBLE_MS, formatRailBadgeCount,
} from "./appConfig";
import type { MailboxView } from "./appTypes";
import { resizeMessageHtmlFrame } from "../components/messageFrameSizing";
import { useAppState } from "./useAppState";
import { useTemporaryMailboxController } from "./useTemporaryMailboxController";
import { useMailboxPolling } from "./useMailboxPolling";
import { useAccountSettingsController } from "./useAccountSettingsController";
import { useDeliveryAgentController } from "./useDeliveryAgentController";
import { useTaxonomyNewsletterController } from "./useTaxonomyNewsletterController";
import { useMailSourceController } from "./useMailSourceController";
import { useMailProjection } from "./useMailProjection";
import { useSelectedMailView } from "./useSelectedMailView";
import { useMessageActionsController } from "./useMessageActionsController";
import { useMailListActionsController } from "./useMailListActionsController";
import { useMailListMoveMenus } from "./useMailListMoveMenus";
import { useMailListFilterMenus } from "./useMailListFilterMenus";
import { useComposeContactsController } from "./useComposeContactsController";
import { useComposeDraftController } from "./useComposeDraftController";
import { useComposeAttachmentController } from "./useComposeAttachmentController";
import { useComposeRichEditor } from "./useComposeRichEditor";
import { useComposeEditorSelection } from "./useComposeEditorSelection";
import { useComposeEditorMenus } from "./useComposeEditorMenus";
import { useInitialDataController } from "./useInitialDataController";
import { useRailPlatformController } from "./useRailPlatformController";
import { useAppLoaders } from "./useAppLoaders";
import { useNormalAccountController } from "./useNormalAccountController";
import { useMailDetailController } from "./useMailDetailController";
import { useLayerController } from "./useLayerController";
import { useAppViewModel } from "./useAppViewModel";
export type { MailboxView } from "./appTypes";


export function useAppController() {
  const appState = useAppState();
  const {
    setActiveView, setRailMode, setRailModePickerOpen, setMailboxView, setMailMoveMenuOpen, setMailLabelMenuOpen,
    setMailMessageMoreMenuOpen, setComposePopoverOpen, setComposePopoverMinimized, composeCcAddress, composeBccAddress, setComposeContactPickerField,
    setComposeContactPickerPosition, composeRecipientDrafts, setSelectedNewsletterSubscription, mailFolders, mailLabels, setSelectedMailTaxonomyFilter,
    messageDetailRequestRef, composeBodyEditorRef, setCopyToast, copyToastTimerRef, setToastVersion, sendTargetAddress,
    setSendBodyText, setSendBodyHtml, setStatusMessage, setStatusToast,
  } = appState;
  const useLayerControllerResult = useLayerController(appState, {
    closeMailTaxonomyManager: () =>
      useTaxonomyNewsletterControllerResult.closeMailTaxonomyManager(),
    closeContactModal: () => useComposeContactsControllerResult.closeContactModal(),
    closeMailSearchOverlay: () => useMailListActionsControllerResult.closeMailSearchOverlay(),
    closeComposePopover: () => useComposeContactsControllerResult.closeComposePopover(),
  });
  const useInitialDataControllerResult = useInitialDataController(appState, {
    clearToastLifecycleTimers: useLayerControllerResult.clearToastLifecycleTimers,
    toastKey: useLayerControllerResult.toastKey,
    toastTone: useLayerControllerResult.toastTone,
    refreshComposeActiveFormats: () =>
      useComposeEditorSelectionResult.refreshComposeActiveFormats(),
  });
  const useRailPlatformControllerResult = useRailPlatformController(appState);
  const useAppLoadersResult = useAppLoaders(appState);
  const useNormalAccountControllerResult = useNormalAccountController(appState, {
    loadNormalAccounts: useAppLoadersResult.loadNormalAccounts,
  });
  const useMailDetailControllerResult = useMailDetailController(appState, {
    invalidateMessageDetailRequest,
    isCanonicalNormalAccountId: useAppLoadersResult.isCanonicalNormalAccountId,
    loadNewsletterSubscriptions: useInitialDataControllerResult.loadNewsletterSubscriptions,
    setMessageLocalFlag: (messageId, flagName, enabled) =>
      useMessageActionsControllerResult.setMessageLocalFlag(messageId, flagName, enabled),
    reloadMailListsAfterLocalAction: () =>
      useMessageActionsControllerResult.reloadMailListsAfterLocalAction(),
    loadRecentCodes: useAppLoadersResult.loadRecentCodes,
    escapeComposePlainTextToHtml: (text) =>
      useComposeDraftControllerResult.escapeComposePlainTextToHtml(text),
    restoreComposeDraftSnapshot: (snapshot) =>
      useComposeDraftControllerResult.restoreComposeDraftSnapshot(snapshot),
    loadSendQueue: useAppLoadersResult.loadSendQueue,
    openAvatarEditor: (sender, target) =>
      useAccountSettingsControllerResult.openAvatarEditor(sender, target),
    closeMailMessageActionMenus,
  });

  function showCopyToast(message: string) {
    setCopyToast(message);
    setToastVersion((value) => value + 1);
    if (copyToastTimerRef.current !== null) {
      window.clearTimeout(copyToastTimerRef.current);
    }
    copyToastTimerRef.current = window.setTimeout(() => {
      setCopyToast(null);
      copyToastTimerRef.current = null;
    }, TOAST_VISIBLE_MS + TOAST_FADE_MS);
  }

  function showStatusToast(message: string) {
    setStatusMessage(message);
    setStatusToast(message);
    setToastVersion((value) => value + 1);
  }

  function invalidateMessageDetailRequest() {
    messageDetailRequestRef.current += 1;
  }

  function closeMailMessageActionMenus() {
    setMailMoveMenuOpen(false);
    setMailLabelMenuOpen(false);
    setMailMessageMoreMenuOpen(false);
  }

  function recipientValueForField(field: ComposeRecipientField) {
    if (field === "to") {
      return sendTargetAddress;
    }
    if (field === "cc") {
      return composeCcAddress;
    }
    return composeBccAddress;
  }

  function composeRecipientsForSend(field: ComposeRecipientField) {
    const committed = recipientValueForField(field);
    const draft = composeRecipientDrafts[field];
    return parseComposeAddressList([committed, draft].filter(Boolean).join(", "));
  }

  function composeRichBodyHtmlToPlainText(editor: HTMLElement): string {
    return editor.innerText.replace(/\u00a0/g, " ");
  }

  function setComposeRichBodyFromPlainText(text: string) {
    setSendBodyText(text);
    setSendBodyHtml("");
    const editor = composeBodyEditorRef.current;
    if (editor) {
      editor.textContent = text;
    }
  }

  function setDraftBodyText(text: string) {
    setComposeRichBodyFromPlainText(text);
  }

  const useDeliveryAgentControllerResult = useDeliveryAgentController(appState, {
    isCanonicalNormalAccountId: useAppLoadersResult.isCanonicalNormalAccountId,
    composeRecipientsForSend,
    composeRichBodyHtmlToPlainText,
    showStatusToast,
    loadSendQueue: useAppLoadersResult.loadSendQueue,
    loadNormalMessages: useMailDetailControllerResult.loadNormalMessages,
    setDraftBodyText,
    loadAgentAccounts: useAppLoadersResult.loadAgentAccounts,
    loadAgentServices: useAppLoadersResult.loadAgentServices,
    loadAgentThreads: useAppLoadersResult.loadAgentThreads,
  });
  const useAccountSettingsControllerResult = useAccountSettingsController(appState);
  const useTemporaryMailboxControllerResult = useTemporaryMailboxController(appState, {
    loadCoreTemporaryState: useInitialDataControllerResult.loadCoreTemporaryState,
    loadNormalAccounts: useAppLoadersResult.loadNormalAccounts,
    showStatusToast,
  });
  const useMailboxPollingResult = useMailboxPolling(appState, {
    pollWaitingMailbox: useTemporaryMailboxControllerResult.pollWaitingMailbox,
    loadCoreTemporaryState: useInitialDataControllerResult.loadCoreTemporaryState,
    loadPromotedMessages: useDeliveryAgentControllerResult.loadPromotedMessages,
  });
  const useMailSourceControllerResult = useMailSourceController(appState, {
    loadSendQueue: useAppLoadersResult.loadSendQueue,
    invalidateMessageDetailRequest,
    loadPromotedMessages: useDeliveryAgentControllerResult.loadPromotedMessages,
    rememberModalReturnFocus: useLayerControllerResult.rememberModalReturnFocus,
    createTempMailbox: useTemporaryMailboxControllerResult.createTempMailbox,
    showStatusToast,
    refreshAnonymousMailOnce: useTemporaryMailboxControllerResult.refreshAnonymousMailOnce,
    loadRecentCodes: useAppLoadersResult.loadRecentCodes,
  });
  const useMailProjectionResult = useMailProjection(appState, {
    tempVisibleMessages: useMailSourceControllerResult.tempVisibleMessages,
    normalImapAccounts: useMailSourceControllerResult.normalImapAccounts,
    promotedAccounts: useMailSourceControllerResult.promotedAccounts,
    allVisibleMailMessages: useMailSourceControllerResult.allVisibleMailMessages,
    loadMessageDetail: useMailDetailControllerResult.loadMessageDetail,
  });
  const useSelectedMailViewResult = useSelectedMailView(appState, {
    paginatedDisplayedMailMessages: useMailProjectionResult.paginatedDisplayedMailMessages,
    displayedMailConversations: useMailProjectionResult.displayedMailConversations,
    displayedMailMessages: useMailProjectionResult.displayedMailMessages,
    normalImapAccounts: useMailSourceControllerResult.normalImapAccounts,
    paginatedDisplayedMailConversations:
      useMailProjectionResult.paginatedDisplayedMailConversations,
  });
  const useMessageActionsControllerResult = useMessageActionsController(appState, {
    selectedVisibleMailMessage: useSelectedMailViewResult.selectedVisibleMailMessage,
    selectedMailMessage: useSelectedMailViewResult.selectedMailMessage,
    normalImapAccounts: useMailSourceControllerResult.normalImapAccounts,
    setDraftBodyText,
    selectedMailMessageIndex: useSelectedMailViewResult.selectedMailMessageIndex,
    paginatedDisplayedMailConversations:
      useMailProjectionResult.paginatedDisplayedMailConversations,
    openMailConversation: useMailDetailControllerResult.openMailConversation,
    loadAnonymousMessages: useAppLoadersResult.loadAnonymousMessages,
    loadNormalMessages: useMailDetailControllerResult.loadNormalMessages,
    promotedAccounts: useMailSourceControllerResult.promotedAccounts,
    loadPromotedMessages: useDeliveryAgentControllerResult.loadPromotedMessages,
    loadRecentCodes: useAppLoadersResult.loadRecentCodes,
    invalidateMessageDetailRequest,
    loadMessageDetail: useMailDetailControllerResult.loadMessageDetail,
    visibleMailMessages: useMailProjectionResult.visibleMailMessages,
    closeMailMessageActionMenus,
  });
  const useTaxonomyNewsletterControllerResult = useTaxonomyNewsletterController(appState, {
    invalidateMessageDetailRequest,
    closeMailMessageActionMenus,
    rememberModalReturnFocus: useLayerControllerResult.rememberModalReturnFocus,
    expandRail: useRailPlatformControllerResult.expandRail,
    showStatusToast,
    loadMailTaxonomyItems: useInitialDataControllerResult.loadMailTaxonomyItems,
    reloadMailListsAfterLocalAction:
      useMessageActionsControllerResult.reloadMailListsAfterLocalAction,
    loadNewsletterSubscriptions: useInitialDataControllerResult.loadNewsletterSubscriptions,
    showCopyToast,
  });
  const useMailListActionsControllerResult = useMailListActionsController(appState, {
    allVisibleMailMessagesSelected: useMailProjectionResult.allVisibleMailMessagesSelected,
    allVisibleMailMessageIds: useMailProjectionResult.allVisibleMailMessageIds,
    displayedMailMessages: useMailProjectionResult.displayedMailMessages,
    mailListTotalPages: useMailProjectionResult.mailListTotalPages,
    mailListActionMessageIds: useMailProjectionResult.mailListActionMessageIds,
    showStatusToast,
    reloadMailListsAfterLocalAction:
      useMessageActionsControllerResult.reloadMailListsAfterLocalAction,
    invalidateMessageDetailRequest,
    setMessageLocalFlag: useMessageActionsControllerResult.setMessageLocalFlag,
    localFolderOptions: mailFolders,
    localLabelOptions: mailLabels,
  });
  const useMailListMoveMenusResult = useMailListMoveMenus(appState, {
    moveSelectedMailMessages: useMailListActionsControllerResult.moveSelectedMailMessages,
    trashSelectedMailMessages: useMailListActionsControllerResult.trashSelectedMailMessages,
    archiveSelectedMailMessages: useMailListActionsControllerResult.archiveSelectedMailMessages,
    deleteSelectedMailMessagesForever:
      useMailListActionsControllerResult.deleteSelectedMailMessagesForever,
    toggleSelectAllVisibleMailMessages:
      useMailListActionsControllerResult.toggleSelectAllVisibleMailMessages,
    allVisibleMailMessagesSelected: useMailProjectionResult.allVisibleMailMessagesSelected,
    replaceSelectionFromPredicate:
      useMailListActionsControllerResult.replaceSelectionFromPredicate,
    clearMailMessageSelection: useMailListActionsControllerResult.clearMailMessageSelection,
    moveAllDisplayedMailMessagesToTrash:
      useMailListActionsControllerResult.moveAllDisplayedMailMessagesToTrash,
    archiveAllDisplayedMailMessages:
      useMailListActionsControllerResult.archiveAllDisplayedMailMessages,
    localFolderOptions: mailFolders,
    closeMailListToolbarMenus: useMailListActionsControllerResult.closeMailListToolbarMenus,
    createMailTaxonomyItem: useTaxonomyNewsletterControllerResult.createMailTaxonomyItem,
    applyMailListMoveTarget: useMailListActionsControllerResult.applyMailListMoveTarget,
  });
  const useMailListFilterMenusResult = useMailListFilterMenus(appState, {
    localLabelOptions: mailLabels,
    closeMailListToolbarMenus: useMailListActionsControllerResult.closeMailListToolbarMenus,
    createMailTaxonomyItem: useTaxonomyNewsletterControllerResult.createMailTaxonomyItem,
    toggleMailListLabelDraft: useMailListActionsControllerResult.toggleMailListLabelDraft,
    applyMailListLabelDraft: useMailListActionsControllerResult.applyMailListLabelDraft,
    snoozeSelectedMailMessages: useMailListActionsControllerResult.snoozeSelectedMailMessages,
    setMailListReadFilterAndClose:
      useMailListActionsControllerResult.setMailListReadFilterAndClose,
    setMailListSortModeAndClose:
      useMailListActionsControllerResult.setMailListSortModeAndClose,
  });
  const useAppViewModelResult = useAppViewModel(appState, {
    visibleMailMessages: useMailProjectionResult.visibleMailMessages,
    selectMailTaxonomyItem: useTaxonomyNewsletterControllerResult.selectMailTaxonomyItem,
    senderAvatarFor: useSelectedMailViewResult.senderAvatarFor,
  });
  const useComposeEditorSelectionResult = useComposeEditorSelection(appState, {
    composeRichBodyHtmlToPlainText,
  });
  const useComposeDraftControllerResult = useComposeDraftController(appState, {
    composeRichBodyHtmlToPlainText,
    syncComposeRichBodyState: useComposeEditorSelectionResult.syncComposeRichBodyState,
    isCanonicalNormalAccountId: useAppLoadersResult.isCanonicalNormalAccountId,
    loadNormalMessages: useMailDetailControllerResult.loadNormalMessages,
    setDraftBodyText,
  });
  const useComposeAttachmentControllerResult = useComposeAttachmentController(appState, {
    rememberModalReturnFocus: useLayerControllerResult.rememberModalReturnFocus,
    readComposeDraftSnapshot: useComposeDraftControllerResult.readComposeDraftSnapshot,
    restoreComposeDraftSnapshot: useComposeDraftControllerResult.restoreComposeDraftSnapshot,
    saveComposeDraftNow: useComposeDraftControllerResult.saveComposeDraftNow,
  });
  const useComposeRichEditorResult = useComposeRichEditor(appState, {
    saveComposeEditorSelection: useComposeEditorSelectionResult.saveComposeEditorSelection,
    syncComposeRichBodyState: useComposeEditorSelectionResult.syncComposeRichBodyState,
    restoreComposeEditorSelection:
      useComposeEditorSelectionResult.restoreComposeEditorSelection,
    nodeIsInsideComposeEditor: useComposeEditorSelectionResult.nodeIsInsideComposeEditor,
    focusComposeBody: useComposeEditorSelectionResult.focusComposeBody,
    rememberModalReturnFocus: useLayerControllerResult.rememberModalReturnFocus,
    showStatusToast,
    setComposeRichBodyFromPlainText,
  });
  const useComposeEditorMenusResult = useComposeEditorMenus(appState, {
    insertComposeRichText: useComposeRichEditorResult.insertComposeRichText,
    applyComposeRichCommand: useComposeRichEditorResult.applyComposeRichCommand,
  });
  const useComposeContactsControllerResult = useComposeContactsController(appState, {
    closeMailSearchOverlay: useMailListActionsControllerResult.closeMailSearchOverlay,
    closeMailListToolbarMenus: useMailListActionsControllerResult.closeMailListToolbarMenus,
    closeComposeFormattingPopovers:
      useComposeRichEditorResult.closeComposeFormattingPopovers,
    rememberModalReturnFocus: useLayerControllerResult.rememberModalReturnFocus,
    recipientValueForField,
    loadContacts: useAppLoadersResult.loadContacts,
  });

  async function queueComposePopoverSend() {
    const sent = await useDeliveryAgentControllerResult.enqueueDraftSend();
    if (sent) {
      useComposeRichEditorResult.closeComposeFormattingPopovers();
      setComposePopoverOpen(false);
      setComposePopoverMinimized(false);
      setComposeContactPickerField(null);
      setComposeContactPickerPosition(null);
    }
  }

  function selectMailRailItem(itemId: MailboxView) {
    setRailMode("mail");
    setRailModePickerOpen(false);
    setMailboxView(itemId);
    if (itemId !== "newsletters") {
      setSelectedNewsletterSubscription(null);
    }
    if (itemId !== "folders" && itemId !== "labels") {
      setSelectedMailTaxonomyFilter(null);
    }
    if (itemId === "folders" || itemId === "labels") {
      setSelectedMailTaxonomyFilter(null);
    }
    setActiveView("mail");
    closeMailMessageActionMenus();
  }
  return {
    ...appState,
    ...useLayerControllerResult,
    ...useInitialDataControllerResult,
    ...useRailPlatformControllerResult,
    ...useAppLoadersResult,
    ...useNormalAccountControllerResult,
    ...useMailDetailControllerResult,
    ...useDeliveryAgentControllerResult,
    ...useAccountSettingsControllerResult,
    ...useTemporaryMailboxControllerResult,
    ...useMailboxPollingResult,
    ...useMailSourceControllerResult,
    ...useMailProjectionResult,
    ...useSelectedMailViewResult,
    ...useMessageActionsControllerResult,
    ...useTaxonomyNewsletterControllerResult,
    ...useMailListActionsControllerResult,
    ...useMailListMoveMenusResult,
    ...useMailListFilterMenusResult,
    ...useAppViewModelResult,
    ...useComposeEditorSelectionResult,
    ...useComposeDraftControllerResult,
    ...useComposeAttachmentControllerResult,
    ...useComposeRichEditorResult,
    ...useComposeEditorMenusResult,
    ...useComposeContactsControllerResult,
    SenderAvatarIcon,
    displayNameFromAddress,
    extractEmailAddress,
    openUrl,
    COMPOSE_FONT_OPTIONS,
    COMPOSE_FONT_SIZE_OPTIONS,
    composeFontCss,
    COMPOSE_COLOR_SWATCHES,
    COMPOSE_EMOJI_CATEGORIES,
    formatComposeDraftSavedAt,
    formatComposeScheduleDate,
    normalizeMailToken,
    formatMailListTime,
    renderLinkedMessageText,
    MailConversationCard,
    renderMailListStateRow,
    ClearFormatIcon,
    EasyEmailAppIcon,
    MailListToolbarIcon,
    RailChevronIcon,
    RailIcon,
    SearchMagnifierIcon,
    MAIL_RAIL_ITEMS,
    MAIL_SEARCH_PRIMARY_SCOPES,
    formatRailBadgeCount,
    resizeMessageHtmlFrame,
    showCopyToast,
    showStatusToast,
    invalidateMessageDetailRequest,
    closeMailMessageActionMenus,
    recipientValueForField,
    composeRecipientsForSend,
    composeRichBodyHtmlToPlainText,
    setComposeRichBodyFromPlainText,
    setDraftBodyText,
    queueComposePopoverSend,
    selectMailRailItem,
  };
}

export type AppController = ReturnType<typeof useAppController>;
