import { useMemo, useRef, useState } from "react";
import type { EasyEmailAuthenticationLinkResult, EasyEmailObservedMessage } from "../api/easyEmailHttpClient";
import type { AvatarSettingsDto } from "../api/avatarSettingsClient";
import type { ContactDto } from "../api/contactClient";
import type { AccountDto, ManualImapAccountCreateRequest, NormalImapConnectionTestDto } from "../api/mailAccountClient";
import type { MailTaxonomyItemDto, MailTaxonomyKind } from "../api/mailTaxonomyClient";
import type { PlatformAccountQueryDto, PlatformAccountSessionDto } from "../api/platformAccountClient";
import type { EasyEmailHealthDto, EasyEmailSettingsDto } from "../api/settingsClient";
import type { SendQueueDto, SendQueueWorkerRunResult } from "../api/sendQueueClient";
import { COMPOSE_DEFAULT_BACKGROUND_COLOR, COMPOSE_DEFAULT_TEXT_COLOR } from "../compose/composeData";
import type { ComposeEmojiCategoryId, ComposeRecipientField } from "../compose/composeData";
import { defaultComposeCustomScheduleDate, defaultComposeExpirationDate, formatComposeLocalDateTimeInput } from "../compose/composeDateUtils";
import { normalizeComposeLinkHref } from "../compose/composeLink";
import type { ComposeLinkType } from "../compose/composeLink";
import type { MailListSortMode } from "../mail/mailSelectors";
import type { VerificationCodeDto } from "../mail/mailSearch";
import { mailTaxonomyDefaultColor } from "../mail/mailTaxonomy";
import type { SenderAvatarDto } from "../components/SenderAvatarIcon";
import { useEventCallback } from "../hooks/useEventCallback";
import type {
  AgentSendTaskDto, AgentServiceDto, AgentThreadDetailDto, AgentThreadDto,
  AgentWorkspace, AnonymousMessageDto, AppView, AvatarEditorState,
  ComposeActiveFormats, ComposeAttachmentDraft, ComposeColorMode,
  ComposeContactPickerPosition, ComposeMoreMenuAnchor, ComposeRecipientMenuState,
  ComposeSchedulePreset, ComposeTextDirection, ErrorDto, LegacyAccountDto,
  MailListReadFilter, MailSearchScope, MailTaxonomySectionExpanded, MailboxView, MessageCache,
  MessageDetailDto, NewsletterSubscriptionCache, PromoteTempMailboxDto, RailMode,
  SelectedMailTaxonomyFilter, SendMessageDto, TempMailboxDto, TempRefreshDto,
} from "./appTypes";

export function useAppState() {
  const [activeView, setActiveView] = useState<AppView>("mail");
  const [railMode, setRailMode] = useState<RailMode>("mail");
  const [railModePickerOpen, setRailModePickerOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [railExpandedReady, setRailExpandedReady] = useState(false);
  const [pendingMailTaxonomyAutoOpenKind, setPendingMailTaxonomyAutoOpenKind] =
      useState<MailTaxonomyKind | null>(null);
  const [agentWorkspace, setAgentWorkspace] = useState<AgentWorkspace>("threads");
  const [mailSourceId, setMailSourceId] = useState("all");
  const [mailboxView, setMailboxView] = useState<MailboxView>("inbox");
  const [onlyCodes, setOnlyCodes] = useState(false);
  const [mailSourceDrawerOpen, setMailSourceDrawerOpen] = useState(false);
  const [mailSourceDropdownOpen, setMailSourceDropdownOpen] = useState(false);
  const [mailAccountPanelOpen, setMailAccountPanelOpen] = useState(false);
  const [mailAccountPanelAdvancedOpen, setMailAccountPanelAdvancedOpen] = useState(false);
  const [mailReadingExpanded, setMailReadingExpanded] = useState(false);
  const [mailMoveMenuOpen, setMailMoveMenuOpen] = useState(false);
  const [mailLabelMenuOpen, setMailLabelMenuOpen] = useState(false);
  const [mailMessageMoreMenuOpen, setMailMessageMoreMenuOpen] = useState(false);
  const [selectedMailMessageIds, setSelectedMailMessageIds] = useState<string[]>([]);
  const [mailListSelectionMenuOpen, setMailListSelectionMenuOpen] = useState(false);
  const [mailListBulkMenuOpen, setMailListBulkMenuOpen] = useState(false);
  const [mailListFilterMenuOpen, setMailListFilterMenuOpen] = useState(false);
  const [mailListMoveMenuOpen, setMailListMoveMenuOpen] = useState(false);
  const [mailListLabelMenuOpen, setMailListLabelMenuOpen] = useState(false);
  const [mailListSnoozeMenuOpen, setMailListSnoozeMenuOpen] = useState(false);
  const [mailListMoveSearch, setMailListMoveSearch] = useState("");
  const [mailListMoveTarget, setMailListMoveTarget] = useState("");
  const [mailListLabelSearch, setMailListLabelSearch] = useState("");
  const [mailListLabelDraftIds, setMailListLabelDraftIds] = useState<string[]>([]);
  const [mailListLabelArchiveAfterApply, setMailListLabelArchiveAfterApply] = useState(false);
  const [mailListReadFilter, setMailListReadFilter] = useState<MailListReadFilter>("all");
  const [mailListHasAttachmentOnly, setMailListHasAttachmentOnly] = useState(false);
  const [mailListSortMode, setMailListSortMode] = useState<MailListSortMode>("newest");
  const [mailListCurrentPage, setMailListCurrentPage] = useState(0);
  const [mailSearchQuery, setMailSearchQuery] = useState("");
  const [mailSearchOverlayOpen, setMailSearchOverlayOpen] = useState(false);
  const [mailSearchAdvancedOpen, setMailSearchAdvancedOpen] = useState(false);
  const [mailSearchScope, setMailSearchScope] = useState<MailSearchScope>("all-mail");
  const [mailSearchFullText, setMailSearchFullText] = useState(true);
  const [mailSearchOtherMenuOpen, setMailSearchOtherMenuOpen] = useState(false);
  const [mailSearchFolderFilter, setMailSearchFolderFilter] = useState("");
  const [mailSearchStartDate, setMailSearchStartDate] = useState("");
  const [mailSearchEndDate, setMailSearchEndDate] = useState("");
  const [mailSearchSender, setMailSearchSender] = useState("");
  const [mailSearchRecipient, setMailSearchRecipient] = useState("");
  const [mailSearchAddress, setMailSearchAddress] = useState("all");
  const [mailSearchHasAttachment, setMailSearchHasAttachment] = useState(false);
  const [composePopoverOpen, setComposePopoverOpen] = useState(false);
  const [composePopoverMinimized, setComposePopoverMinimized] = useState(false);
  const [composePopoverExpanded, setComposePopoverExpanded] = useState(false);
  const [composeCcOpen, setComposeCcOpen] = useState(false);
  const [composeBccOpen, setComposeBccOpen] = useState(false);
  const [composeCcAddress, setComposeCcAddress] = useState("");
  const [composeBccAddress, setComposeBccAddress] = useState("");
  const [composeContactPickerField, setComposeContactPickerField] =
      useState<ComposeRecipientField | null>(null);
  const [composeContactPickerPosition, setComposeContactPickerPosition] =
      useState<ComposeContactPickerPosition | null>(null);
  const [composeRecipientDrafts, setComposeRecipientDrafts] = useState<
      Record<ComposeRecipientField, string>
    >({ to: "", cc: "", bcc: "" });
  const [composeRecipientMenu, setComposeRecipientMenu] =
      useState<ComposeRecipientMenuState | null>(null);
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [contactDraftFirstName, setContactDraftFirstName] = useState("");
  const [contactDraftLastName, setContactDraftLastName] = useState("");
  const [contactDraftDisplayName, setContactDraftDisplayName] = useState("");
  const [contactDraftEmail, setContactDraftEmail] = useState("");
  const [contactDraftPhone, setContactDraftPhone] = useState("");
  const [contactDraftAddress, setContactDraftAddress] = useState("");
  const [contactDraftBirthday, setContactDraftBirthday] = useState("");
  const [contactDraftOrganization, setContactDraftOrganization] = useState("");
  const [contactDraftTitle, setContactDraftTitle] = useState("");
  const [contactDraftNote, setContactDraftNote] = useState("");
  const [contactDraftTargetField, setContactDraftTargetField] =
      useState<ComposeRecipientField | null>(null);
  const [, setSettings] = useState<EasyEmailSettingsDto | null>(null);
  const [avatarSettings, setAvatarSettings] = useState<AvatarSettingsDto>({
      remote_enabled: true,
      bimi_enabled: true,
      favicon_enabled: true,
      auth_enabled: true,
    });
  const [senderAvatarsBySender, setSenderAvatarsBySender] = useState<Record<string, SenderAvatarDto>>({});
  const [easyEmailHealth, setEasyEmailHealth] = useState<EasyEmailHealthDto | null>(null);
  const [platformSession, setPlatformSession] = useState<PlatformAccountSessionDto | null>(null);
  const [lastPlatformQuery, setLastPlatformQuery] = useState<PlatformAccountQueryDto | null>(null);
  const [platformAccountMenuOpen, setPlatformAccountMenuOpen] = useState(false);
  const [platformAccountSignedIn, setPlatformAccountSignedIn] = useState(true);
  const [platformAccountAvatarDataUrl, setPlatformAccountAvatarDataUrl] = useState<string | null>(
      () =>
        typeof window === "undefined"
          ? null
          : window.localStorage.getItem("nmail.platformAccountAvatarDataUrl"),
    );
  const [normalAccounts, setNormalAccounts] = useState<AccountDto[]>([]);
  const canonicalNormalAccountIdsRef = useRef(new Set<string>());
  const [tempMailboxes, setTempMailboxes] = useState<TempMailboxDto[]>([]);
  const [anonymousMessages, setAnonymousMessages] = useState<AnonymousMessageDto[]>([]);
  const [normalMessagesByAccount, setNormalMessagesByAccount] = useState<MessageCache>({});
  const [promotedMessagesByAccount, setPromotedMessagesByAccount] = useState<MessageCache>({});
  const [newsletterSubscriptionsByAccount, setNewsletterSubscriptionsByAccount] =
      useState<NewsletterSubscriptionCache>({});
  const [selectedNewsletterSubscription, setSelectedNewsletterSubscription] =
      useState<{ accountId: string; subscriptionId: string } | null>(null);
  const [showHiddenNewsletterSubscriptions, setShowHiddenNewsletterSubscriptions] =
      useState(false);
  const [mailFolders, setMailFolders] = useState<MailTaxonomyItemDto[]>([]);
  const [mailLabels, setMailLabels] = useState<MailTaxonomyItemDto[]>([]);
  const [selectedMailTaxonomyFilter, setSelectedMailTaxonomyFilter] =
      useState<SelectedMailTaxonomyFilter>(null);
  const [mailTaxonomySectionExpanded, setMailTaxonomySectionExpanded] =
      useState<MailTaxonomySectionExpanded>({ folder: false, label: false });
  const [mailTaxonomyManagerKind, setMailTaxonomyManagerKind] =
      useState<MailTaxonomyKind | null>(null);
  const [mailTaxonomyEditingId, setMailTaxonomyEditingId] = useState<string | null>(null);
  const [mailTaxonomyDraftName, setMailTaxonomyDraftName] = useState("");
  const [mailTaxonomyDraftParentId, setMailTaxonomyDraftParentId] = useState<string>("");
  const [mailTaxonomyDraftColor, setMailTaxonomyDraftColor] = useState(() =>
      mailTaxonomyDefaultColor("folder", 0),
    );
  const [railNavScrollState, setRailNavScrollState] = useState({ top: false, bottom: false });
  const railNavRef = useRef<HTMLElement | null>(null);
  const modalReturnFocusRef = useRef<HTMLElement | null>(null);
  const mailAutoSyncInFlightRef = useRef(false);
  const busyOperationCountRef = useRef(0);
  const mountedRef = useRef(true);
  const messageDetailRequestRef = useRef(0);
  const initialLoadRequestRef = useRef(0);
  const coreObservedMessagesRef = useRef(new Map<string, EasyEmailObservedMessage>());
  const [sendQueue, setSendQueue] = useState<SendQueueDto[]>([]);
  const [agentAccounts, setAgentAccounts] = useState<LegacyAccountDto[]>([]);
  const [agentServices, setAgentServices] = useState<AgentServiceDto[]>([]);
  const [agentThreads, setAgentThreads] = useState<AgentThreadDto[]>([]);
  const [selectedNormalAccountId, setSelectedNormalAccountId] = useState<string | null>(null);
  const [selectedAgentSenderId, setSelectedAgentSenderId] = useState<string | null>(null);
  const [selectedAgentServiceId, setSelectedAgentServiceId] = useState<string | null>(null);
  const [selectedAgentThreadDetail, setSelectedAgentThreadDetail] =
      useState<AgentThreadDetailDto | null>(null);
  const [selectedMessageDetail, setSelectedMessageDetail] = useState<MessageDetailDto | null>(null);
  const [selectedMailMessageId, setSelectedMailMessageId] = useState<string | null>(null);
  const [selectedMailConversationKey, setSelectedMailConversationKey] = useState<string | null>(null);
  const [avatarEditor, setAvatarEditor] = useState<AvatarEditorState | null>(null);
  const avatarUploadSenderRef = useRef<string | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const platformAvatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const composeBodyEditorRef = useRef<HTMLDivElement | null>(null);
  const composeSavedSelectionRangeRef = useRef<Range | null>(null);
  const composeImageInputRef = useRef<HTMLInputElement | null>(null);
  const composeAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const copyToastTimerRef = useRef<number | null>(null);
  const [toastVisibleKey, setToastVisibleKey] = useState<string | null>(null);
  const [toastFading, setToastFading] = useState(false);
  const [toastVersion, setToastVersion] = useState(0);
  const toastFadeTimerRef = useRef<number | null>(null);
  const toastRemoveTimerRef = useRef<number | null>(null);
  const [recentCodes, setRecentCodes] = useState<VerificationCodeDto[]>([]);
  const [lastRefresh, setLastRefresh] = useState<TempRefreshDto | null>(null);
  const [lastAuthenticationLink, setLastAuthenticationLink] =
      useState<EasyEmailAuthenticationLinkResult | null>(null);
  const [lastPromotion, setLastPromotion] = useState<PromoteTempMailboxDto | null>(null);
  const [normalImapTest, setNormalImapTest] = useState<NormalImapConnectionTestDto | null>(null);
  const [lastSend, setLastSend] = useState<SendMessageDto | null>(null);
  const [lastSendWorkerRun, setLastSendWorkerRun] = useState<SendQueueWorkerRunResult | null>(null);
  const [lastAgentTask, setLastAgentTask] = useState<AgentSendTaskDto | null>(null);
  const [serviceUrl, setServiceUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [normalDisplayName, setNormalDisplayName] = useState("Work");
  const [normalEmailAddress, setNormalEmailAddress] = useState("");
  const [normalImapHost, setNormalImapHost] = useState("");
  const [normalImapPort, setNormalImapPort] = useState("993");
  const [normalImapSecurity, setNormalImapSecurity] =
      useState<ManualImapAccountCreateRequest["imap_security"]>("tls");
  const [normalImapUsername, setNormalImapUsername] = useState("");
  const [normalImapPassword, setNormalImapPassword] = useState("");
  const [sendTargetAddress, setSendTargetAddress] = useState("");
  const [sendSubject, setSendSubject] = useState("");
  const [sendBodyText, setSendBodyText] = useState("");
  const [sendBodyHtml, setSendBodyHtml] = useState("");
  const [composeFontFamily, setComposeFontFamily] = useState("Arial");
  const [composeFontSize, setComposeFontSize] = useState("14px");
  const [composeFormatbarOpen, setComposeFormatbarOpen] = useState(false);
  const [composeMoreMenuOpen, setComposeMoreMenuOpen] = useState(false);
  const [composeMoreMenuAnchor, setComposeMoreMenuAnchor] =
      useState<ComposeMoreMenuAnchor>("toolbar");
  const [composeAiMoreMenuOpen, setComposeAiMoreMenuOpen] = useState(false);
  const [composeBottomMoreOpen, setComposeBottomMoreOpen] = useState(false);
  const [composeEncryptionMenuOpen, setComposeEncryptionMenuOpen] = useState(false);
  const [composeEncryptionModalOpen, setComposeEncryptionModalOpen] = useState(false);
  const [composeEncryptionPassword, setComposeEncryptionPassword] = useState("");
  const [composeEncryptionHint, setComposeEncryptionHint] = useState("");
  const [composeEncryptionPasswordVisible, setComposeEncryptionPasswordVisible] = useState(false);
  const [composePlainTextMode, setComposePlainTextMode] = useState(false);
  const [composeAttachPublicKey, setComposeAttachPublicKey] = useState(false);
  const [composeRequestReadReceipt, setComposeRequestReadReceipt] = useState(false);
  const [composeExpirationEnabled, setComposeExpirationEnabled] = useState(false);
  const [composeExpirationModalOpen, setComposeExpirationModalOpen] = useState(false);
  const [composeExpirationDate, setComposeExpirationDate] = useState(defaultComposeExpirationDate);
  const [composeExpirationTime, setComposeExpirationTime] = useState("09:00");
  const [composeExpirationSendOutside, setComposeExpirationSendOutside] = useState(false);
  const [composeExternalEncryption, setComposeExternalEncryption] = useState(false);
  const [composeAiAssistVisible, setComposeAiAssistVisible] = useState(false);
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachmentDraft[]>([]);
  const [composeScheduleSendOpen, setComposeScheduleSendOpen] = useState(false);
  const [composeSchedulePreset, setComposeSchedulePreset] =
      useState<ComposeSchedulePreset>(null);
  const [composeScheduledAtIso, setComposeScheduledAtIso] = useState<string | null>(null);
  const [composeScheduleCustomValue, setComposeScheduleCustomValue] = useState(() =>
      formatComposeLocalDateTimeInput(defaultComposeCustomScheduleDate()),
    );
  const [composeDraftSavedAt, setComposeDraftSavedAt] = useState<string | null>(null);
  const [composeDraftDirty, setComposeDraftDirty] = useState(false);
  const [composePersistedDraftId, setComposePersistedDraftId] = useState<string | null>(null);
  const composePersistedDraftIdRef = useRef<string | null>(null);
  const composeDraftHydratedRef = useRef(false);
  const composeDraftRevisionRef = useRef(0);
  const [composeTextDirection, setComposeTextDirection] = useState<ComposeTextDirection>("ltr");
  const [composeFontMenuOpen, setComposeFontMenuOpen] = useState(false);
  const [composeFontSizeMenuOpen, setComposeFontSizeMenuOpen] = useState(false);
  const [composeColorMenuOpen, setComposeColorMenuOpen] = useState(false);
  const [composeAlignmentMenuOpen, setComposeAlignmentMenuOpen] = useState(false);
  const [composeEmojiPickerOpen, setComposeEmojiPickerOpen] = useState(false);
  const [composeEmojiActiveCategoryId, setComposeEmojiActiveCategoryId] =
      useState<ComposeEmojiCategoryId>("recent");
  const [composeEmojiSearch, setComposeEmojiSearch] = useState("");
  const [composeLinkModalOpen, setComposeLinkModalOpen] = useState(false);
  const [composeLinkType, setComposeLinkType] = useState<ComposeLinkType>("web");
  const [composeLinkUrl, setComposeLinkUrl] = useState("");
  const [composeLinkText, setComposeLinkText] = useState("");
  const normalizedComposeLinkHref = useMemo(
      () => normalizeComposeLinkHref(composeLinkUrl, composeLinkType),
      [composeLinkType, composeLinkUrl],
    );
  const [composeActiveFormats, setComposeActiveFormats] = useState<ComposeActiveFormats>({
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      unorderedList: false,
      orderedList: false,
      quote: false,
    });
  const [composeColorMode, setComposeColorMode] = useState<ComposeColorMode>("text");
  const [composeTextColor, setComposeTextColor] = useState(COMPOSE_DEFAULT_TEXT_COLOR);
  const [composeBackgroundColor, setComposeBackgroundColor] = useState(
      COMPOSE_DEFAULT_BACKGROUND_COLOR,
    );
  const [agentDisplayName, setAgentDisplayName] = useState("Agent Sender");
  const [agentEmailAddress, setAgentEmailAddress] = useState("");
  const [agentServiceName, setAgentServiceName] = useState("Remote Agent");
  const [agentServiceEmail, setAgentServiceEmail] = useState("");
  const [agentServiceDescription, setAgentServiceDescription] = useState("");
  const [agentTrustLevel, setAgentTrustLevel] = useState("trusted");
  const [agentTaskSubject, setAgentTaskSubject] = useState("");
  const [agentTaskBody, setAgentTaskBody] = useState("");
  const [confirmRestrictedAgent, setConfirmRestrictedAgent] = useState(false);
  const [targetService, setTargetService] = useState("");
  const [note, setNote] = useState("");
  const [waitForCode, setWaitForCode] = useState(true);
  const [waitingMailboxId, setWaitingMailboxId] = useState<string | null>(null);
  const [selectedTempMailboxId, setSelectedTempMailboxId] = useState("");
  const [tempRecoveryEmail, setTempRecoveryEmail] = useState("");
  const [tempRecoveryProviderType, setTempRecoveryProviderType] = useState("");
  const [tempMailboxFromContains, setTempMailboxFromContains] = useState("");
  const [tempOutcomeFailureReason, setTempOutcomeFailureReason] = useState("");
  const [tempSendTo, setTempSendTo] = useState("");
  const [tempSendSubject, setTempSendSubject] = useState("");
  const [tempSendBody, setTempSendBody] = useState("");
  const [statusMessage, setStatusMessage] = useState("正在启动本地 EasyEmail 核心…");
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDto | null>(null);
  const [busy, setBusyState] = useState(true);
  const [initializing, setInitializing] = useState(true);
  const [mailSyncInProgress, setMailSyncInProgress] = useState(false);
  const setBusy = useEventCallback((nextBusy: boolean) => {
      busyOperationCountRef.current = nextBusy
        ? busyOperationCountRef.current + 1
        : Math.max(0, busyOperationCountRef.current - 1);
      if (mountedRef.current) {
        setBusyState(busyOperationCountRef.current > 0);
      }
    });
  return {
    activeView, setActiveView, railMode, setRailMode, railModePickerOpen, setRailModePickerOpen, railCollapsed, setRailCollapsed,
    railExpandedReady, setRailExpandedReady, pendingMailTaxonomyAutoOpenKind, setPendingMailTaxonomyAutoOpenKind, agentWorkspace, setAgentWorkspace, mailSourceId, setMailSourceId,
    mailboxView, setMailboxView, onlyCodes, setOnlyCodes, mailSourceDrawerOpen, setMailSourceDrawerOpen, mailSourceDropdownOpen, setMailSourceDropdownOpen,
    mailAccountPanelOpen, setMailAccountPanelOpen, mailAccountPanelAdvancedOpen, setMailAccountPanelAdvancedOpen, mailReadingExpanded, setMailReadingExpanded, mailMoveMenuOpen, setMailMoveMenuOpen,
    mailLabelMenuOpen, setMailLabelMenuOpen, mailMessageMoreMenuOpen, setMailMessageMoreMenuOpen, selectedMailMessageIds, setSelectedMailMessageIds, mailListSelectionMenuOpen, setMailListSelectionMenuOpen,
    mailListBulkMenuOpen, setMailListBulkMenuOpen, mailListFilterMenuOpen, setMailListFilterMenuOpen, mailListMoveMenuOpen, setMailListMoveMenuOpen, mailListLabelMenuOpen, setMailListLabelMenuOpen,
    mailListSnoozeMenuOpen, setMailListSnoozeMenuOpen, mailListMoveSearch, setMailListMoveSearch, mailListMoveTarget, setMailListMoveTarget, mailListLabelSearch, setMailListLabelSearch,
    mailListLabelDraftIds, setMailListLabelDraftIds, mailListLabelArchiveAfterApply, setMailListLabelArchiveAfterApply, mailListReadFilter, setMailListReadFilter, mailListHasAttachmentOnly, setMailListHasAttachmentOnly,
    mailListSortMode, setMailListSortMode, mailListCurrentPage, setMailListCurrentPage, mailSearchQuery, setMailSearchQuery, mailSearchOverlayOpen, setMailSearchOverlayOpen,
    mailSearchAdvancedOpen, setMailSearchAdvancedOpen, mailSearchScope, setMailSearchScope, mailSearchFullText, setMailSearchFullText, mailSearchOtherMenuOpen, setMailSearchOtherMenuOpen,
    mailSearchFolderFilter, setMailSearchFolderFilter, mailSearchStartDate, setMailSearchStartDate, mailSearchEndDate, setMailSearchEndDate, mailSearchSender, setMailSearchSender,
    mailSearchRecipient, setMailSearchRecipient, mailSearchAddress, setMailSearchAddress, mailSearchHasAttachment, setMailSearchHasAttachment, composePopoverOpen, setComposePopoverOpen,
    composePopoverMinimized, setComposePopoverMinimized, composePopoverExpanded, setComposePopoverExpanded, composeCcOpen, setComposeCcOpen, composeBccOpen, setComposeBccOpen,
    composeCcAddress, setComposeCcAddress, composeBccAddress, setComposeBccAddress, composeContactPickerField, setComposeContactPickerField, composeContactPickerPosition, setComposeContactPickerPosition,
    composeRecipientDrafts, setComposeRecipientDrafts, composeRecipientMenu, setComposeRecipientMenu, contacts, setContacts, contactModalOpen, setContactModalOpen,
    contactDraftFirstName, setContactDraftFirstName, contactDraftLastName, setContactDraftLastName, contactDraftDisplayName, setContactDraftDisplayName, contactDraftEmail, setContactDraftEmail,
    contactDraftPhone, setContactDraftPhone, contactDraftAddress, setContactDraftAddress, contactDraftBirthday, setContactDraftBirthday, contactDraftOrganization, setContactDraftOrganization,
    contactDraftTitle, setContactDraftTitle, contactDraftNote, setContactDraftNote, contactDraftTargetField, setContactDraftTargetField, setSettings, avatarSettings,
    setAvatarSettings, senderAvatarsBySender, setSenderAvatarsBySender, easyEmailHealth, setEasyEmailHealth, platformSession, setPlatformSession, lastPlatformQuery,
    setLastPlatformQuery, platformAccountMenuOpen, setPlatformAccountMenuOpen, platformAccountSignedIn, setPlatformAccountSignedIn, platformAccountAvatarDataUrl, setPlatformAccountAvatarDataUrl, normalAccounts,
    setNormalAccounts, canonicalNormalAccountIdsRef, tempMailboxes, setTempMailboxes, anonymousMessages, setAnonymousMessages, normalMessagesByAccount, setNormalMessagesByAccount,
    promotedMessagesByAccount, setPromotedMessagesByAccount, newsletterSubscriptionsByAccount, setNewsletterSubscriptionsByAccount, selectedNewsletterSubscription, setSelectedNewsletterSubscription, showHiddenNewsletterSubscriptions, setShowHiddenNewsletterSubscriptions,
    mailFolders, setMailFolders, mailLabels, setMailLabels, selectedMailTaxonomyFilter, setSelectedMailTaxonomyFilter, mailTaxonomySectionExpanded, setMailTaxonomySectionExpanded,
    mailTaxonomyManagerKind, setMailTaxonomyManagerKind, mailTaxonomyEditingId, setMailTaxonomyEditingId, mailTaxonomyDraftName, setMailTaxonomyDraftName, mailTaxonomyDraftParentId, setMailTaxonomyDraftParentId,
    mailTaxonomyDraftColor, setMailTaxonomyDraftColor, railNavScrollState, setRailNavScrollState, railNavRef, modalReturnFocusRef, mailAutoSyncInFlightRef, busyOperationCountRef,
    mountedRef, messageDetailRequestRef, initialLoadRequestRef, coreObservedMessagesRef, sendQueue, setSendQueue, agentAccounts, setAgentAccounts,
    agentServices, setAgentServices, agentThreads, setAgentThreads, selectedNormalAccountId, setSelectedNormalAccountId, selectedAgentSenderId, setSelectedAgentSenderId,
    selectedAgentServiceId, setSelectedAgentServiceId, selectedAgentThreadDetail, setSelectedAgentThreadDetail, selectedMessageDetail, setSelectedMessageDetail, selectedMailMessageId, setSelectedMailMessageId,
    selectedMailConversationKey, setSelectedMailConversationKey, avatarEditor, setAvatarEditor, avatarUploadSenderRef, avatarFileInputRef, platformAvatarFileInputRef, composeBodyEditorRef,
    composeSavedSelectionRangeRef, composeImageInputRef, composeAttachmentInputRef, copyToast, setCopyToast, copyToastTimerRef, toastVisibleKey, setToastVisibleKey,
    toastFading, setToastFading, toastVersion, setToastVersion, toastFadeTimerRef, toastRemoveTimerRef, recentCodes, setRecentCodes,
    lastRefresh, setLastRefresh, lastAuthenticationLink, setLastAuthenticationLink, lastPromotion, setLastPromotion, normalImapTest, setNormalImapTest,
    lastSend, setLastSend, lastSendWorkerRun, setLastSendWorkerRun, lastAgentTask, setLastAgentTask, serviceUrl, setServiceUrl,
    apiToken, setApiToken, normalDisplayName, setNormalDisplayName, normalEmailAddress, setNormalEmailAddress, normalImapHost, setNormalImapHost,
    normalImapPort, setNormalImapPort, normalImapSecurity, setNormalImapSecurity, normalImapUsername, setNormalImapUsername, normalImapPassword, setNormalImapPassword,
    sendTargetAddress, setSendTargetAddress, sendSubject, setSendSubject, sendBodyText, setSendBodyText, sendBodyHtml, setSendBodyHtml,
    composeFontFamily, setComposeFontFamily, composeFontSize, setComposeFontSize, composeFormatbarOpen, setComposeFormatbarOpen, composeMoreMenuOpen, setComposeMoreMenuOpen,
    composeMoreMenuAnchor, setComposeMoreMenuAnchor, composeAiMoreMenuOpen, setComposeAiMoreMenuOpen, composeBottomMoreOpen, setComposeBottomMoreOpen, composeEncryptionMenuOpen, setComposeEncryptionMenuOpen,
    composeEncryptionModalOpen, setComposeEncryptionModalOpen, composeEncryptionPassword, setComposeEncryptionPassword, composeEncryptionHint, setComposeEncryptionHint, composeEncryptionPasswordVisible, setComposeEncryptionPasswordVisible,
    composePlainTextMode, setComposePlainTextMode, composeAttachPublicKey, setComposeAttachPublicKey, composeRequestReadReceipt, setComposeRequestReadReceipt, composeExpirationEnabled, setComposeExpirationEnabled,
    composeExpirationModalOpen, setComposeExpirationModalOpen, composeExpirationDate, setComposeExpirationDate, composeExpirationTime, setComposeExpirationTime, composeExpirationSendOutside, setComposeExpirationSendOutside,
    composeExternalEncryption, setComposeExternalEncryption, composeAiAssistVisible, setComposeAiAssistVisible, composeAttachments, setComposeAttachments, composeScheduleSendOpen, setComposeScheduleSendOpen,
    composeSchedulePreset, setComposeSchedulePreset, composeScheduledAtIso, setComposeScheduledAtIso, composeScheduleCustomValue, setComposeScheduleCustomValue, composeDraftSavedAt, setComposeDraftSavedAt,
    composeDraftDirty, setComposeDraftDirty, composePersistedDraftId, setComposePersistedDraftId, composePersistedDraftIdRef, composeDraftHydratedRef, composeDraftRevisionRef, composeTextDirection,
    setComposeTextDirection, composeFontMenuOpen, setComposeFontMenuOpen, composeFontSizeMenuOpen, setComposeFontSizeMenuOpen, composeColorMenuOpen, setComposeColorMenuOpen, composeAlignmentMenuOpen,
    setComposeAlignmentMenuOpen, composeEmojiPickerOpen, setComposeEmojiPickerOpen, composeEmojiActiveCategoryId, setComposeEmojiActiveCategoryId, composeEmojiSearch, setComposeEmojiSearch, composeLinkModalOpen,
    setComposeLinkModalOpen, composeLinkType, setComposeLinkType, composeLinkUrl, setComposeLinkUrl, composeLinkText, setComposeLinkText, normalizedComposeLinkHref,
    composeActiveFormats, setComposeActiveFormats, composeColorMode, setComposeColorMode, composeTextColor, setComposeTextColor, composeBackgroundColor, setComposeBackgroundColor,
    agentDisplayName, setAgentDisplayName, agentEmailAddress, setAgentEmailAddress, agentServiceName, setAgentServiceName, agentServiceEmail, setAgentServiceEmail,
    agentServiceDescription, setAgentServiceDescription, agentTrustLevel, setAgentTrustLevel, agentTaskSubject, setAgentTaskSubject, agentTaskBody, setAgentTaskBody,
    confirmRestrictedAgent, setConfirmRestrictedAgent, targetService, setTargetService, note, setNote, waitForCode, setWaitForCode,
    waitingMailboxId, setWaitingMailboxId, selectedTempMailboxId, setSelectedTempMailboxId, tempRecoveryEmail, setTempRecoveryEmail, tempRecoveryProviderType, setTempRecoveryProviderType,
    tempMailboxFromContains, setTempMailboxFromContains, tempOutcomeFailureReason, setTempOutcomeFailureReason, tempSendTo, setTempSendTo, tempSendSubject, setTempSendSubject,
    tempSendBody, setTempSendBody, statusMessage, setStatusMessage, statusToast, setStatusToast, error, setError,
    busy, setBusyState, initializing, setInitializing, mailSyncInProgress, setMailSyncInProgress, setBusy,
  };
}

export type AppState = ReturnType<typeof useAppState>;
