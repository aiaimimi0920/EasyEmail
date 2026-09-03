import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  CSSProperties,
  SyntheticEvent,
} from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createBundledCoreClient } from "./api/bundledCoreClient";
import {
  EasyEmailHttpError,
  type EasyEmailAuthenticationLinkResult,
  type EasyEmailObservedMessage,
} from "./api/easyEmailHttpClient";
import {
  createAvatarSettingsClient,
  type AvatarSettingsDto,
} from "./api/avatarSettingsClient";
import { preprocessContactAvatarFile } from "./avatar/contactAvatarImage";
import { createContactClient, type ContactDto } from "./api/contactClient";
import { createDesktopCredentialClient } from "./api/desktopCredentialClient";
import {
  createMailAccountClient,
  type AccountDto,
  type ManualImapAccountCreateRequest,
  type NormalImapConnectionTestDto,
} from "./api/mailAccountClient";
import {
  createMailTaxonomyClient,
  type MailTaxonomyDeleteDto,
  type MailTaxonomyItemDto,
  type MailTaxonomyKind,
} from "./api/mailTaxonomyClient";
import {
  createNewsletterClient,
  type NewsletterSubscriptionDto,
} from "./api/newsletterClient";
import {
  createPlatformAccountClient,
  type PlatformAccountQueryDto,
  type PlatformAccountQueryResource,
  type PlatformAccountSessionDto,
} from "./api/platformAccountClient";
import {
  createSettingsClient,
  type EasyEmailHealthDto,
  type EasyEmailSettingsDto,
} from "./api/settingsClient";
import {
  createSendQueueClient,
  type SendQueueDto,
  type SendQueueWorkerRunResult,
} from "./api/sendQueueClient";
import {
  COMPOSE_COLOR_SWATCHES,
  COMPOSE_DEFAULT_BACKGROUND_COLOR,
  COMPOSE_DEFAULT_TEXT_COLOR,
  COMPOSE_EMOJI_CATEGORIES,
  COMPOSE_FONT_OPTIONS,
  COMPOSE_FONT_SIZE_OPTIONS,
  appendComposeRecipientValue,
  composeContactPickerAriaLabel,
  composeFontCss,
  filterComposeEmojiCategories,
  joinComposeAddressList,
  parseComposeAddressList,
  type ComposeEmojiCategoryId,
  type ComposeRecipientField,
} from "./compose/composeData";
import {
  defaultComposeCustomScheduleDate,
  defaultComposeExpirationDate,
  formatComposeDraftSavedAt,
  formatComposeLocalDateTimeInput,
  formatComposeScheduleDate,
  positivePort,
} from "./compose/composeDateUtils";
import { buildComposeImageHtml, validateComposeImageFile } from "./compose/composeImage";
import { sanitizeComposeHtml } from "./compose/composeHtmlSanitizer";
import {
  normalizeComposeLinkHref,
  type ComposeLinkType,
} from "./compose/composeLink";
import {
  buildMailConversations,
  buildMailRailCounts,
  extractEmailAddress,
  displayNameFromAddress,
  filterVisibleMailMessagesForMailbox,
  mailConversationKeyForMessage,
  normalizeMailToken,
  sortMailListMessages,
  sortVisibleMailMessagesByTime,
  visibleMailMessageHasAttachment,
  type MailConversationSummary as MailConversationSummaryModel,
  type MailListSortMode,
} from "./mail/mailSelectors";
import { formatMailListTime } from "./mail/mailDateUtils";
import { renderLinkedMessageText } from "./mail/messageLinkRenderer";
import {
  temporaryMailboxRecordFromOpenResult,
  temporaryMailboxRefreshFailureMessage,
  temporaryMailboxRefreshView,
  temporaryMailboxViewFromSession,
  temporaryObservedMessageView,
  temporaryVerificationCodeView,
  type TemporaryMailboxView,
  type TemporaryMailboxRefreshView,
} from "./mail/temporaryMailboxAdapter";
import {
  detectInlineVerificationCode,
  mailSearchMessageMatchesAdvancedFilters,
  visibleMailMessageSearchText,
  type VerificationCodeDto,
} from "./mail/mailSearch";
import {
  buildMailTaxonomyFolderTree,
  isMailTaxonomyFolderDescendant,
  mailTaxonomyDefaultColor,
  mailTaxonomyItemMatchesName,
} from "./mail/mailTaxonomy";
import { paginateMailConversations } from "./mail/mailPagination";
import {
  MailConversationCard,
  renderMailListStateRow,
} from "./components/MailConversationCard";
import {
  ClearFormatIcon,
  EasyEmailAppIcon,
  MailListToolbarIcon,
  RailChevronIcon,
  RailIcon,
  SearchMagnifierIcon,
} from "./components/AppIcons";
import {
  SenderAvatarIcon,
  type SenderAvatarDto,
} from "./components/SenderAvatarIcon";
import { useEventCallback } from "./hooks/useEventCallback";
import {
  useModalAccessibility,
  useNonModalLayerAccessibility,
} from "./hooks/useLayerAccessibility";
import { senderAvatarMapKey } from "./mail/senderAvatar";
import { createNonOverlappingAsyncRunner } from "./utils/asyncTask";
import "./App.css";
import "./styles/neuro-canonical.css";

const bundledCoreClient = createBundledCoreClient(invoke);
const avatarSettingsClient = createAvatarSettingsClient(invoke);
const contactClient = createContactClient(bundledCoreClient);
const desktopCredentialClient = createDesktopCredentialClient(invoke);
const mailAccountClient = createMailAccountClient(bundledCoreClient, desktopCredentialClient);
const mailTaxonomyClient = createMailTaxonomyClient(invoke);
const newsletterClient = createNewsletterClient(invoke);
const platformAccountClient = createPlatformAccountClient(invoke);
const settingsClient = createSettingsClient(invoke);
const sendQueueClient = createSendQueueClient(invoke);

type TempMailboxDto = TemporaryMailboxView;

type TempRefreshDto = TemporaryMailboxRefreshView;

type CoreTemporaryState = {
  mailboxes: TempMailboxDto[];
  messages: AnonymousMessageDto[];
  codes: VerificationCodeDto[];
};

type LegacyAccountDto = Omit<AccountDto, "version" | "credential_refs">;

type SendMessageDto = {
  message_id: string;
  queue_id: string;
  status: string;
};

type AgentServiceDto = {
  id: string;
  display_name: string;
  email_address: string;
  description: string | null;
  service_kind: string;
  trust_level: string;
  default_sender_account_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type AgentThreadDto = {
  id: string;
  agent_service_id: string;
  sender_account_id: string;
  subject: string;
  status: string;
  last_outgoing_message_id: string | null;
  last_incoming_message_id: string | null;
  correlation_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type AgentMessageDto = {
  id: string;
  thread_id: string;
  message_id: string;
  direction: string;
  semantic_role: string;
  parsed_status: string | null;
  created_at: string;
};

type AgentThreadDetailDto = {
  thread: AgentThreadDto;
  messages: AgentMessageDto[];
};

type AgentSendTaskDto = {
  thread: AgentThreadDto;
  agent_message: AgentMessageDto;
  queue_id: string;
  queue_status: string;
};

type AnonymousMessageDto = {
  message_id: string;
  thread_key: string | null;
  temp_mailbox_id: string;
  received_address: string;
  provider_label: string;
  subject: string;
  from_address: string;
  snippet: string;
  observed_at: string;
  lifecycle_state: string;
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
  is_important: boolean;
  local_folder: string;
  labels: string[];
  newsletter_subscription_id: string | null;
};

type MailTaxonomySectionExpanded = {
  folder: boolean;
  label: boolean;
};

type MessageDetailDto = {
  message_id: string;
  account_id: string;
  thread_key: string | null;
  received_address: string;
  subject: string;
  from_address: string;
  snippet: string;
  observed_at: string;
  body_text: string | null;
  body_html: string | null;
  body_cache_state: string;
  draft_cc_addresses: string[];
  draft_bcc_addresses: string[];
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
  is_important: boolean;
  local_folder: string;
  labels: string[];
};

type MessageLocalActionDto = {
  message_id: string;
  changed: boolean;
  status: string;
  remote_applied: boolean;
};

type LocalDraftSaveDto = {
  message_id: string;
  saved_at: string;
};

type MessageBatchActionDto = {
  requested_count: number;
  changed_count: number;
  remote_applied_count: number;
};

type PromoteTempMailboxDto = {
  account: LegacyAccountDto;
  mailbox: TempMailboxDto;
};

type ErrorDto = {
  code: string;
  user_message: string;
  correlation_id: string;
};

type AppView = "mail" | "agent" | "queue" | "setup";

type RailMode = "mail" | "agent";

type MailRailItemId =
  | "compose"
  | "inbox"
  | "drafts"
  | "sent"
  | "starred"
  | "archive"
  | "spam"
  | "trash"
  | "all-mail"
  | "newsletters"
  | "folders"
  | "labels";

type MailboxView = Exclude<MailRailItemId, "compose">;

type MailSearchScope =
  | "all-mail"
  | "inbox"
  | "drafts"
  | "sent"
  | "starred"
  | "archive"
  | "spam"
  | "trash"
  | "snoozed"
  | "scheduled";

type AgentWorkspace = "threads" | "compose" | "attention" | "services";

type ComposeRecipientMenuState = {
  field: ComposeRecipientField;
  address: string;
  x: number;
  y: number;
};

type ComposeContactPickerPosition = Pick<CSSProperties, "left" | "top">;

type ComposeColorMode = "text" | "background";

type ComposeMoreMenuAnchor = "toolbar" | "formatbar";

type ComposeTextDirection = "ltr" | "rtl";

type ComposeAlignmentValue = "left" | "center" | "right";

type ComposeActiveFormats = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  unorderedList: boolean;
  orderedList: boolean;
  quote: boolean;
};

type ComposeSchedulePreset = "custom" | null;

type ComposeAttachmentDraft = {
  id: string;
  name: string;
  size: number;
};

type ComposeDraftSnapshot = {
  persistedDraftId: string | null;
  senderAccountId: string | null;
  to: string;
  cc: string;
  bcc: string;
  recipientDrafts: Record<ComposeRecipientField, string>;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  plainTextMode: boolean;
  attachPublicKey: boolean;
  requestReadReceipt: boolean;
  expirationEnabled: boolean;
  externalEncryption: boolean;
  scheduledAtIso: string | null;
  savedAt: string;
};

type MailListReadFilter = "all" | "unread" | "read";

type MailListPrimaryMoveAction = "inbox" | "trash" | "archive" | "spam" | "nospam" | "delete";

type MailRailItem = {
  id: MailRailItemId;
  label: string;
};

const COMPOSE_DRAFT_AUTOSAVE_MS = 5000;
const COMPOSE_DRAFT_STORAGE_KEY = "easyemailam.composeDraft.v1";
const TOAST_VISIBLE_MS = 3600;
const TOAST_FADE_MS = 900;
const MAIL_AUTO_SYNC_INTERVAL_MS = 120000;
const MAIL_LIST_PAGE_SIZE = 20;

const MAIL_RAIL_ITEMS: MailRailItem[] = [
  { id: "compose", label: "写邮件" },
  { id: "inbox", label: "收件箱" },
  { id: "drafts", label: "草稿" },
  { id: "sent", label: "已发送" },
  { id: "starred", label: "星标" },
  { id: "archive", label: "归档" },
  { id: "spam", label: "垃圾邮件" },
  { id: "trash", label: "回收站" },
  { id: "all-mail", label: "全部邮件" },
  { id: "newsletters", label: "订阅邮件" },
];

type MailSearchScopeOption = {
  id: MailSearchScope;
  label: string;
  icon: string;
};

const MAIL_SEARCH_PRIMARY_SCOPES: MailSearchScopeOption[] = [
  { id: "all-mail", label: "所有邮件", icon: "✉" },
  { id: "inbox", label: "收件箱", icon: "⌂" },
  { id: "drafts", label: "草稿", icon: "▤" },
  { id: "sent", label: "已发送", icon: "✈" },
];

const MAIL_SEARCH_OTHER_SCOPES: MailSearchScopeOption[] = [
  { id: "all-mail", label: "所有邮件", icon: "✉" },
  { id: "inbox", label: "收件箱", icon: "⌂" },
  { id: "snoozed", label: "延迟通知", icon: "◴" },
  { id: "drafts", label: "草稿", icon: "▤" },
  { id: "scheduled", label: "定时延迟通知", icon: "✈" },
  { id: "sent", label: "已发送", icon: "✈" },
  { id: "starred", label: "星标邮件", icon: "☆" },
  { id: "archive", label: "归档", icon: "▱" },
  { id: "spam", label: "垃圾邮件", icon: "♨" },
];

function formatRailBadgeCount(count: number | null): string | null {
  if (count === null || count <= 0) {
    return null;
  }
  return count > 99 ? "99+" : String(count);
}

type MailSource = {
  id: string;
  label: string;
  meta: string;
  tone: "signal" | "cyan" | "info";
};

type MessageCache = Record<string, AnonymousMessageDto[]>;
type NewsletterSubscriptionCache = Record<string, NewsletterSubscriptionDto[]>;

type VisibleNewsletterSubscription = NewsletterSubscriptionDto & {
  account_id: string;
};

type SelectedMailTaxonomyFilter = {
  kind: MailTaxonomyKind;
  name: string;
} | null;

type VisibleMailMessage = AnonymousMessageDto & {
  sourceLabel: string;
  sourceId: string;
  body_text?: string | null;
  account_id?: string;
};

type CodeBackedMailMessage = VisibleMailMessage & {
  verificationCode: VerificationCodeDto;
};

type MailConversationSummary = MailConversationSummaryModel<
  VisibleMailMessage,
  VerificationCodeDto
>;

function asErrorDto(value: unknown): ErrorDto {
  if (value instanceof EasyEmailHttpError) {
    const payload =
      typeof value.payload === "object" && value.payload !== null
        ? (value.payload as Record<string, unknown>)
        : {};
    const payloadCode =
      typeof payload.code === "string"
        ? payload.code
        : typeof payload.error === "string"
          ? payload.error
          : `http_${value.status}`;
    const userMessage =
      value.status === 401
        ? "The local EasyEmail core rejected its runtime credential. Restart NMail and try again."
        : value.status === 404
          ? "The requested mailbox or message no longer exists. Refresh the mailbox list."
          : value.status >= 500
            ? `The EasyEmail core or selected provider could not complete the request: ${value.message}`
            : value.message;
    return {
      code: payloadCode,
      user_message: userMessage,
      correlation_id: "core-http",
    };
  }

  if (value instanceof Error) {
    const message = value.message.trim();
    const normalizedMessage = message.toLowerCase();
    const isTimeout = value.name === "AbortError" || normalizedMessage.includes("timed out");
    const coreExited = normalizedMessage.includes("core exited");
    const coreUnreachable =
      normalizedMessage.includes("failed to fetch") ||
      normalizedMessage.includes("networkerror") ||
      normalizedMessage.includes("network request failed");
    return {
      code: isTimeout
        ? "request_timeout"
        : coreExited
          ? "core_exited"
          : coreUnreachable
            ? "core_unreachable"
            : "request_failed",
      user_message: isTimeout
        ? "The EasyEmail core or provider timed out. Retry the mailbox action."
        : coreExited
          ? "The local EasyEmail core exited. Restart NMail and try again."
          : coreUnreachable
            ? "NMail cannot reach the local EasyEmail core. Confirm it is running and retry."
            : message || "NMail could not complete the request.",
      correlation_id: "desktop-runtime",
    };
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<ErrorDto>;
    return {
      code: typeof candidate.code === "string" ? candidate.code : "unknown_error",
      user_message:
        typeof candidate.user_message === "string"
          ? candidate.user_message
          : "NMail could not complete the request.",
      correlation_id:
        typeof candidate.correlation_id === "string" ? candidate.correlation_id : "unknown",
    };
  }

  return {
    code: "unknown_error",
    user_message: "NMail could not complete the request.",
    correlation_id: "unknown",
  };
}

function temporaryRefreshError(result: TempRefreshDto): ErrorDto | null {
  const message = temporaryMailboxRefreshFailureMessage(result);
  return message
    ? {
        code: "MAILBOX_REFRESH_PARTIAL_FAILURE",
        user_message: message,
        correlation_id: "core-http-refresh",
      }
    : null;
}

function optionalValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeByIdentity<T>(
  preferred: T[],
  existing: T[],
  identity: (value: T) => string,
): T[] {
  const seen = new Set<string>();
  return [...preferred, ...existing].filter((value) => {
    const key = identity(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type AvatarEditorState = {
  sender: string;
  left: number;
  top: number;
};

function resizeMessageHtmlFrame(event: SyntheticEvent<HTMLIFrameElement>) {
  const frame = event.currentTarget;
  try {
    const documentElement = frame.contentDocument?.documentElement;
    const body = frame.contentDocument?.body;
    if (!documentElement || !body) {
      return;
    }

    const height = Math.max(
      documentElement.scrollHeight,
      body.scrollHeight,
      documentElement.offsetHeight,
      body.offsetHeight,
      480,
    );
    frame.style.height = `${height}px`;
  } catch {
    frame.style.height = "760px";
  }
}

function applyMailSearchScopeFilter(
  messages: VisibleMailMessage[],
  scope: MailSearchScope,
): VisibleMailMessage[] {
  if (scope === "snoozed" || scope === "scheduled") {
    return [];
  }
  return filterVisibleMailMessagesForMailbox(messages, scope);
}

function isQqMailAddress(value: string): boolean {
  return value.trim().toLowerCase().endsWith("@qq.com");
}

function App() {
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
  // Keep the app busy until every overlapping foreground operation has settled.
  const setBusy = useEventCallback((nextBusy: boolean) => {
    busyOperationCountRef.current = nextBusy
      ? busyOperationCountRef.current + 1
      : Math.max(0, busyOperationCountRef.current - 1);
    if (mountedRef.current) {
      setBusyState(busyOperationCountRef.current > 0);
    }
  });
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
  const toastTone = error ? "error" : copyToast ? "copy" : "status";
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

  async function loadNewsletterSubscriptions(
    accountId: string | null,
    isCurrent: () => boolean = () => true,
  ) {
    if (!accountId) {
      return [];
    }
    const subscriptions = await newsletterClient.listNewsletterSubscriptions({
      account_id: accountId,
    });
    if (!isCurrent()) {
      return subscriptions;
    }
    setNewsletterSubscriptionsByAccount((current) => ({
      ...current,
      [accountId]: subscriptions,
    }));
    return subscriptions;
  }

  async function loadMailTaxonomyItems(isCurrent: () => boolean = () => true) {
    const [folders, labels] = await Promise.all([
      mailTaxonomyClient.listMailTaxonomyItems({ kind: "folder" }),
      mailTaxonomyClient.listMailTaxonomyItems({ kind: "label" }),
    ]);
    if (!isCurrent()) {
      return { folders, labels };
    }
    setMailFolders(folders);
    setMailLabels(labels);
    return { folders, labels };
  }

  async function loadCoreTemporaryState(): Promise<CoreTemporaryState> {
    const hostId = await bundledCoreClient.getHostId();
    const [{ sessions }, { instances }, { messages: allObservedMessages }] = await Promise.all([
      bundledCoreClient.queryMailboxSessions({
        hostId,
        newestFirst: true,
        limit: 500,
      }),
      bundledCoreClient.queryProviderInstances(),
      bundledCoreClient.queryObservedMessages({ newestFirst: true, limit: 5000 }),
    ]);
    const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
    const mailboxes = sessions.map((session) =>
      temporaryMailboxViewFromSession(session, instancesById.get(session.providerInstanceId)),
    );
    const mailboxesById = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
    const sessionIds = new Set(sessions.map((session) => session.id));
    const observedMessages = allObservedMessages.filter((message) =>
      sessionIds.has(message.sessionId),
    );
    coreObservedMessagesRef.current = new Map(
      observedMessages.map((message) => [message.id, message]),
    );
    const messages = observedMessages.flatMap((message) => {
      const mailbox = mailboxesById.get(message.sessionId);
      return mailbox ? [temporaryObservedMessageView(message, mailbox)] : [];
    });
    const codes = observedMessages.flatMap((message) => {
      const mailbox = mailboxesById.get(message.sessionId);
      if (!mailbox || !message.extractedCode) return [];
      return [
        temporaryVerificationCodeView(
          {
            sessionId: message.sessionId,
            providerInstanceId: message.providerInstanceId,
            code: message.extractedCode,
            source: message.codeSource ?? "text",
            observedMessageId: message.id,
            receivedAt: message.observedAt,
            candidates: message.extractedCandidates,
          },
          mailbox,
          message,
        ),
      ];
    });
    return {
      mailboxes,
      messages,
      codes: codes.slice(0, 100),
    };
  }

  async function loadInitialState(isCurrent: () => boolean = () => true) {
    setInitializing(true);
    setStatusMessage("正在启动本地 EasyEmail 核心并加载邮件数据…");
    setBusy(true);
    try {
      const [
        ,
        settingsResult,
        avatarSettingsResult,
        coreTemporaryState,
        platformSessionResult,
        accountsResult,
        messagesResult,
        codesResult,
        sendQueueResult,
        contactsResult,
        agentAccountsResult,
        agentServicesResult,
        agentThreadsResult,
        taxonomyResult,
      ] = await Promise.all([
        bundledCoreClient.getCatalog(),
        settingsClient.getEasyEmailSettings(),
        avatarSettingsClient.getAvatarSettings(),
        loadCoreTemporaryState(),
        platformAccountClient.getPlatformAccountSession(),
        mailAccountClient.listNormalAccounts(),
        invoke<AnonymousMessageDto[]>("message_list", {
          request: { scope: "anonymous", account_id: null, include_archived: true },
        }),
        invoke<VerificationCodeDto[]>("verification_list_recent", {
          request: { temp_mailbox_id: null, limit: 100 },
        }),
        sendQueueClient.listSendQueue({ limit: 25 }),
        contactClient.listContacts(),
        invoke<LegacyAccountDto[]>("agent_list_accounts"),
        invoke<AgentServiceDto[]>("agent_list_services"),
        invoke<AgentThreadDto[]>("agent_list_threads"),
        loadMailTaxonomyItems(isCurrent),
      ]);
      if (!isCurrent()) {
        return;
      }
      // Normal-account messages and derived newsletters remain owned by the M4/M6
      // migration. Do not cross-read the legacy Rust database using core account IDs.
      const normalMessageCache: MessageCache = {};
      const promotedMessageCache: MessageCache = {};
      const newsletterSubscriptionCache: NewsletterSubscriptionCache = {};

      if (!isCurrent()) {
        return;
      }

      setSettings(settingsResult);
      setAvatarSettings(avatarSettingsResult);
      setPlatformSession(platformSessionResult);
      setServiceUrl(settingsResult.service_url ?? "");
      canonicalNormalAccountIdsRef.current = new Set(accountsResult.map((account) => account.id));
      setNormalAccounts(accountsResult);
      setTempMailboxes(coreTemporaryState.mailboxes);
      setAnonymousMessages(
        mergeByIdentity(
          coreTemporaryState.messages,
          messagesResult,
          (message) => message.message_id,
        ),
      );
      setNormalMessagesByAccount(normalMessageCache);
      setPromotedMessagesByAccount(promotedMessageCache);
      setNewsletterSubscriptionsByAccount(newsletterSubscriptionCache);
      setMailFolders(taxonomyResult.folders);
      setMailLabels(taxonomyResult.labels);
      setRecentCodes(
        mergeByIdentity(coreTemporaryState.codes, codesResult, (code) => code.id),
      );
      setSendQueue(sendQueueResult);
      setContacts(contactsResult);
      setAgentAccounts(agentAccountsResult);
      setAgentServices(agentServicesResult);
      setAgentThreads(agentThreadsResult);
      setSelectedAgentSenderId(agentAccountsResult[0]?.id ?? null);
      setSelectedAgentServiceId(agentServicesResult[0]?.id ?? null);
      setStatusMessage("Local core is ready.");
      setError(null);
    } catch (caught: unknown) {
      if (isCurrent()) {
        setError(asErrorDto(caught));
        setStatusMessage("NMail could not load its local state.");
      }
    } finally {
      if (isCurrent()) {
        setInitializing(false);
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++initialLoadRequestRef.current;
    const isCurrent = () => initialLoadRequestRef.current === requestId;
    void loadInitialState(isCurrent);
    return () => {
      initialLoadRequestRef.current += 1;
      mountedRef.current = false;
      setBusy(false);
    };
  }, []);

  useEffect(() => {
    setSelectedTempMailboxId((current) => {
      if (tempMailboxes.some((mailbox) => mailbox.id === current)) {
        return current;
      }
      return (
        tempMailboxes.find((mailbox) => mailbox.lifecycle_state === "active")?.id ??
        tempMailboxes[0]?.id ??
        ""
      );
    });
  }, [tempMailboxes]);

  useEffect(() => {
    setLastAuthenticationLink(null);
  }, [selectedTempMailboxId]);

  useEffect(() => {
    clearToastLifecycleTimers();

    if (!toastKey) {
      setToastVisibleKey(null);
      setToastFading(false);
      return undefined;
    }

    setToastVisibleKey(toastKey);
    setToastFading(false);
    if (toastTone === "error") {
      return () => clearToastLifecycleTimers();
    }
    toastFadeTimerRef.current = window.setTimeout(() => {
      setToastFading(true);
    }, TOAST_VISIBLE_MS);
    toastRemoveTimerRef.current = window.setTimeout(() => {
      setToastVisibleKey(null);
      setToastFading(false);
      if (toastTone === "status") {
        setStatusToast(null);
      }
      if (toastTone === "copy") {
        setCopyToast(null);
      }
      toastRemoveTimerRef.current = null;
    }, TOAST_VISIBLE_MS + TOAST_FADE_MS);

    return () => clearToastLifecycleTimers();
  }, [toastKey]);

  useEffect(
    () => () => {
      if (copyToastTimerRef.current !== null) {
        window.clearTimeout(copyToastTimerRef.current);
      }
      clearToastLifecycleTimers();
    },
    [],
  );

  useEffect(() => {
    const refresh = () => refreshComposeActiveFormats();
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
  }, []);

  useEffect(() => {
    if (!composePopoverOpen || composePopoverMinimized) {
      return undefined;
    }
    const focusFrame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>("[data-compose-initial-focus]")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [composePopoverOpen, composePopoverMinimized]);

  useEffect(() => {
    if (railCollapsed) {
      setPlatformAccountMenuOpen(false);
    }
  }, [railCollapsed]);

  useEffect(() => {
    if (railCollapsed) {
      setRailExpandedReady(false);
      return;
    }

    const timer = window.setTimeout(() => setRailExpandedReady(true), 320);
    return () => window.clearTimeout(timer);
  }, [railCollapsed]);

  useEffect(() => {
    if (railExpandedReady && pendingMailTaxonomyAutoOpenKind) {
      setMailTaxonomySectionExpanded(
        pendingMailTaxonomyAutoOpenKind === "folder"
          ? { folder: true, label: false }
          : { folder: false, label: true },
      );
      setPendingMailTaxonomyAutoOpenKind(null);
    }
  }, [pendingMailTaxonomyAutoOpenKind, railExpandedReady]);

  function updateRailNavScrollState() {
    const nav = railNavRef.current;
    if (!nav) {
      setRailNavScrollState({ top: false, bottom: false });
      return;
    }
    const top = nav.scrollTop > 2;
    const bottom = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 2;
    setRailNavScrollState((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  }

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(updateRailNavScrollState);
    const nav = railNavRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !nav
        ? null
        : new ResizeObserver(() => {
            window.requestAnimationFrame(updateRailNavScrollState);
          });
    if (nav) {
      resizeObserver?.observe(nav);
    }
    window.addEventListener("resize", updateRailNavScrollState);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateRailNavScrollState);
    };
  }, [
    activeView,
    mailFolders,
    mailLabels,
    mailTaxonomySectionExpanded,
    railCollapsed,
    railExpandedReady,
    railMode,
  ]);

  async function queryPlatformAccount(resource: PlatformAccountQueryResource) {
    try {
      const result = await platformAccountClient.queryPlatformAccountData({ resource });
      setLastPlatformQuery(result);
      if (resource === "session") {
        const session = await platformAccountClient.getPlatformAccountSession();
        setPlatformSession(session);
      }
      setStatusMessage(`平台账户查询 ${resource} 已返回：${result.status}。`);
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    }
  }

  function openPlatformAccountPopover() {
    setPlatformAccountMenuOpen(true);
    if (platformAccountSignedIn) {
      void queryPlatformAccount("profile");
    }
  }

  function selectRailMode(mode: RailMode) {
    setRailMode(mode);
    setRailModePickerOpen(false);
    setActiveView(mode === "mail" ? "mail" : "agent");
  }

  function toggleRailModePicker() {
    if (!railCollapsed) {
      return;
    }
    setRailModePickerOpen((value) => !value);
  }

  function expandRail() {
    setRailModePickerOpen(false);
    setRailExpandedReady(false);
    setRailCollapsed(false);
  }

  function collapseRail() {
    setRailModePickerOpen(false);
    setRailExpandedReady(false);
    setRailCollapsed(true);
  }

  async function signInPlatformAccount() {
    setBusy(true);
    try {
      const session = await platformAccountClient.getPlatformAccountSession();
      setPlatformSession(session);
      setPlatformAccountSignedIn(true);
      setPlatformAccountMenuOpen(true);
      setStatusMessage("已登录 NMail 开发预览账户。");
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  function signOutPlatformAccount() {
    setPlatformAccountSignedIn(false);
    setLastPlatformQuery(null);
    setStatusMessage("已退出 NMail 开发预览账户。");
    setError(null);
  }

  function choosePlatformAvatarFile() {
    setPlatformAccountMenuOpen(false);
    platformAvatarFileInputRef.current?.click();
  }

  async function handlePlatformAvatarFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) {
      return;
    }

    setBusy(true);
    try {
      const imageDataUrl = await preprocessContactAvatarFile(file);
      setPlatformAccountAvatarDataUrl(imageDataUrl);
      window.localStorage.setItem("nmail.platformAccountAvatarDataUrl", imageDataUrl);
      setStatusMessage("已更新平台账户图标。");
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadRecentCodes(
    tempMailboxId: string | null = null,
    isCurrent: () => boolean = () => true,
  ) {
    const codes = await invoke<VerificationCodeDto[]>("verification_list_recent", {
      request: { temp_mailbox_id: tempMailboxId, limit: 100 },
    });
    if (!isCurrent()) {
      return codes;
    }
    setRecentCodes(codes);
    return codes;
  }

  async function loadAnonymousMessages() {
    const messages = await invoke<AnonymousMessageDto[]>("message_list", {
      request: { scope: "anonymous", account_id: null, include_archived: true },
    });
    setAnonymousMessages(messages);
    return messages;
  }

  async function loadNormalAccounts() {
    const accounts = await mailAccountClient.listNormalAccounts();
    canonicalNormalAccountIdsRef.current = new Set(accounts.map((account) => account.id));
    setNormalAccounts(accounts);
    return accounts;
  }

  function isCanonicalNormalAccountId(accountId: string): boolean {
    return canonicalNormalAccountIdsRef.current.has(accountId)
      || normalAccounts.some((account) => account.id === accountId);
  }

  async function loadSendQueue(isCurrent: () => boolean = () => true) {
    const rows = await sendQueueClient.listSendQueue({ limit: 25 });
    if (!isCurrent()) {
      return rows;
    }
    setSendQueue(rows);
    return rows;
  }

  async function loadContacts() {
    const rows = await contactClient.listContacts();
    setContacts(rows);
    return rows;
  }

  async function loadAgentAccounts() {
    const accounts = await invoke<LegacyAccountDto[]>("agent_list_accounts");
    setAgentAccounts(accounts);
    return accounts;
  }

  async function loadAgentServices() {
    const services = await invoke<AgentServiceDto[]>("agent_list_services");
    setAgentServices(services);
    return services;
  }

  async function loadAgentThreads() {
    const threads = await invoke<AgentThreadDto[]>("agent_list_threads");
    setAgentThreads(threads);
    return threads;
  }

  function normalImapAccountRequest(): ManualImapAccountCreateRequest {
    return {
      display_name: normalDisplayName,
      email_address: normalEmailAddress,
      imap_host: normalImapHost,
      imap_port: positivePort(normalImapPort),
      imap_security: normalImapSecurity,
      imap_username: normalImapUsername.trim() || mailboxLoginUsername(),
      imap_password: normalImapPassword,
    };
  }

  function mailboxLoginUsername() {
    return normalEmailAddress.trim().toLowerCase();
  }

  function updateMailboxAuthorizationCode(value: string) {
    setNormalImapPassword(value);
  }

  function updateNormalEmailAddress(value: string) {
    const normalizedAddress = value.trim().toLowerCase();
    setNormalEmailAddress(value);
    if (
      normalizedAddress.length > 0 &&
      (normalImapUsername.trim().length === 0 ||
        normalImapUsername === normalEmailAddress ||
        normalImapHost === "imap.qq.com")
    ) {
      setNormalImapUsername(normalizedAddress);
    }
    applyMailboxProviderDefaults(normalizedAddress);
  }

  function applyMailboxProviderDefaults(address: string, force = false) {
    if (!force && !isQqMailAddress(address)) {
      return;
    }

    setNormalDisplayName((value) =>
      value.trim().length === 0 || value.trim() === "Work" ? "QQ Mail" : value,
    );
    setNormalImapHost("imap.qq.com");
    setNormalImapPort("993");
    setNormalImapSecurity("tls");
    if (address.length > 0) {
      setNormalEmailAddress(address);
      setNormalImapUsername(address);
    }
  }

  function applyQqMailPreset() {
    const address = normalEmailAddress.trim().toLowerCase();
    applyMailboxProviderDefaults(address, true);
    setStatusMessage("已应用 QQ 邮箱预设。请使用 QQ 邮箱授权码，而不是 QQ 登录密码。");
  }

  async function testNormalImap(account: AccountDto) {
    setBusy(true);
    try {
      const result = await mailAccountClient.testImap(account);
      setSelectedNormalAccountId(account.id);
      setNormalImapTest(result);
      setStatusMessage(`IMAP connection test: ${result.capability_summary}.`);
      setError(null);
    } catch (caught: unknown) {
      setNormalImapTest(null);
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function addManualImapAccount() {
    setBusy(true);
    try {
      const result = await mailAccountClient.addManualImapAccount(normalImapAccountRequest());
      await loadNormalAccounts();
      setSelectedNormalAccountId(result.account.id);
      setMailSourceId(`account:${result.account.id}`);
      setMailAccountPanelOpen(false);
      try {
        const testResult = await mailAccountClient.testImap(result.account);
        setNormalImapTest(testResult);
        setStatusMessage(
          `Added ${result.account.display_name}; IMAP authenticated (${testResult.capability_summary}). SMTP and synchronization remain unavailable until M5/M6.`,
        );
        setError(null);
      } catch (testError: unknown) {
        setNormalImapTest(null);
        setStatusMessage(
          `Added ${result.account.display_name}, but its IMAP connection test failed. The account remains available for review or deletion.`,
        );
        setError(asErrorDto(testError));
      }
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setNormalImapPassword("");
      setBusy(false);
    }
  }

  async function disableNormalAccount(account: AccountDto) {
    setBusy(true);
    try {
      const updated = await mailAccountClient.disableAccount(account);
      canonicalNormalAccountIdsRef.current.add(updated.id);
      setNormalAccounts((current) => current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      ));
      setNormalImapTest(null);
      setStatusMessage(`${updated.display_name} is disabled.`);
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function deleteNormalAccount(account: AccountDto) {
    if (!window.confirm(`Delete ${account.display_name}? Existing messages remain history-only.`)) {
      return;
    }
    setBusy(true);
    try {
      const result = await mailAccountClient.deleteAccount(account);
      const accounts = await loadNormalAccounts();
      if (selectedNormalAccountId === account.id) {
        const nextAccount = accounts.find((candidate) => candidate.kind === "normal_long_lived") ?? null;
        setSelectedNormalAccountId(nextAccount?.id ?? null);
        setMailSourceId(nextAccount ? `account:${nextAccount.id}` : "all");
        setNormalImapTest(null);
      }
      setStatusMessage(
        result.credential_cleanup_complete
          ? `${account.display_name} was deleted and its desktop credential was removed.`
          : `${account.display_name} was deleted, but one desktop credential could not be removed.`,
      );
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadNormalMessages(
    accountId: string | null,
    isCurrent: () => boolean = () => true,
  ) {
    if (!accountId) {
      invalidateMessageDetailRequest();
      setSelectedMessageDetail(null);
      return [];
    }

    if (isCanonicalNormalAccountId(accountId)) {
      if (isCurrent()) {
        setNormalMessagesByAccount((current) => ({ ...current, [accountId]: [] }));
      }
      return [];
    }

    const [messages] = await Promise.all([
      invoke<AnonymousMessageDto[]>("message_list", {
        request: { scope: "normal_account", account_id: accountId, include_archived: true },
      }),
      loadNewsletterSubscriptions(accountId, isCurrent),
    ]);
    if (!isCurrent()) {
      return messages;
    }
    setNormalMessagesByAccount((current) => ({ ...current, [accountId]: messages }));
    return messages;
  }

  async function loadMessageDetail(messageId: string, markRead = false) {
    const requestId = ++messageDetailRequestRef.current;
    const isCurrent = () => messageDetailRequestRef.current === requestId;
    setBusy(true);
    try {
      const knownCoreMessage = coreObservedMessagesRef.current.get(messageId);
      const coreMessage = knownCoreMessage
        ? (await bundledCoreClient.getObservedMessage(messageId)).message ?? knownCoreMessage
        : undefined;
      const coreMailbox = coreMessage
        ? tempMailboxes.find((mailbox) => mailbox.id === coreMessage.sessionId)
        : undefined;
      let detail: MessageDetailDto = coreMessage
        ? {
            message_id: coreMessage.id,
            account_id: "",
            thread_key: null,
            received_address: coreMailbox?.email_address ?? "",
            subject: coreMessage.subject ?? "(no subject)",
            from_address: coreMessage.sender ?? "",
            snippet: (coreMessage.textBody ?? coreMessage.subject ?? "").slice(0, 240),
            observed_at: coreMessage.observedAt,
            body_text: coreMessage.textBody ?? null,
            body_html: coreMessage.htmlBody ?? null,
            body_cache_state: "available",
            draft_cc_addresses: [],
            draft_bcc_addresses: [],
            is_read: markRead,
            is_starred: false,
            is_archived: false,
            is_important: false,
            local_folder: "inbox",
            labels: [],
          }
        : await invoke<MessageDetailDto>("message_get_detail", {
            request: { message_id: messageId },
          });
      if (!isCurrent()) {
        return;
      }
      if (!coreMessage && markRead && !detail.is_read) {
        await setMessageLocalFlag(messageId, "read", true);
        await reloadMailListsAfterLocalAction();
        if (!isCurrent()) {
          return;
        }
        detail = { ...detail, is_read: true };
      }
      const detailCodeCandidate = detectInlineVerificationCode({
        message_id: detail.message_id,
        temp_mailbox_id: "",
        received_address: detail.received_address,
        provider_label: "",
        subject: detail.subject,
        thread_key: detail.thread_key,
        from_address: detail.from_address,
        snippet: detail.snippet,
        observed_at: detail.observed_at,
        lifecycle_state: "detail",
        is_read: detail.is_read,
        is_starred: detail.is_starred,
        is_archived: detail.is_archived,
        is_important: detail.is_important,
        local_folder: detail.local_folder,
        labels: detail.labels,
        newsletter_subscription_id: null,
        sourceLabel: "",
        sourceId: "",
        body_text: detail.body_text,
        account_id: detail.account_id,
      });
      if (!coreMessage && detailCodeCandidate) {
        try {
          const code = await invoke<VerificationCodeDto | null>("verification_reclassify_message", {
            request: { message_id: messageId },
          });
          if (code && isCurrent()) {
            await loadRecentCodes(null, isCurrent);
          }
        } catch {
          // Opening the message should not fail just because code classification failed.
        }
      }
      if (!isCurrent()) {
        return;
      }
      setSelectedMessageDetail(detail);
      setStatusMessage(`Loaded message detail for ${detail.subject}.`);
      setError(null);
    } catch (caught: unknown) {
      if (isCurrent()) {
        setError(asErrorDto(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  function isPendingScheduledSent(message: VisibleMailMessage) {
    return message.local_folder === "sent" && message.labels.includes("未发送");
  }

  function restoreMessageDetailIntoCompose(
    detail: MessageDetailDto,
    fallbackMessage: VisibleMailMessage,
    status: string,
  ) {
    const bodyText = detail.body_text ?? "";
    const bodyHtml = detail.body_html ?? escapeComposePlainTextToHtml(bodyText);
    composeDraftHydratedRef.current = true;
    restoreComposeDraftSnapshot({
      persistedDraftId: detail.message_id,
      senderAccountId: detail.account_id || selectedNormalAccountId,
      to: detail.received_address || fallbackMessage.received_address,
      cc: detail.draft_cc_addresses.join(", "),
      bcc: detail.draft_bcc_addresses.join(", "),
      recipientDrafts: { to: "", cc: "", bcc: "" },
      subject: detail.subject,
      bodyText,
      bodyHtml,
      plainTextMode: composePlainTextMode,
      attachPublicKey: composeAttachPublicKey,
      requestReadReceipt: composeRequestReadReceipt,
      expirationEnabled: composeExpirationEnabled,
      externalEncryption: composeExternalEncryption,
      scheduledAtIso: null,
      savedAt: detail.observed_at,
    });
    setComposeSchedulePreset(null);
    setComposeScheduledAtIso(null);
    setComposeScheduleCustomValue("");
    setComposeScheduleSendOpen(false);
    setComposePopoverOpen(true);
    setComposePopoverMinimized(false);
    setMailboxView("drafts");
    setSelectedMailMessageId(detail.message_id);
    setSelectedMailConversationKey(mailConversationKeyForMessage(fallbackMessage));
    setSelectedMessageDetail(detail);
    setComposeDraftDirty(false);
    setStatusMessage(status);
    setError(null);
  }

  async function openLocalDraftForEditing(message: VisibleMailMessage) {
    setBusy(true);
    try {
      const detail = await invoke<MessageDetailDto>("message_get_detail", {
        request: { message_id: message.message_id },
      });
      restoreMessageDetailIntoCompose(detail, message, "Draft opened for editing.");
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function openScheduledSendForEditing(message: VisibleMailMessage) {
    setBusy(true);
    try {
      const detail = await invoke<MessageDetailDto>("message_reopen_scheduled_send", {
        request: { message_id: message.message_id },
      });
      const accountId = detail.account_id || selectedNormalAccountId;
      await Promise.all([
        loadSendQueue(),
        accountId ? loadNormalMessages(accountId) : Promise.resolve([]),
      ]);
      restoreMessageDetailIntoCompose(
        detail,
        message,
        "Scheduled send cancelled and opened for editing.",
      );
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  // Stable identities for the props handed to the memoized list card. Without
  // these, each render would produce new function objects and the memo would
  // never hit. Declared here so they sit beside the handlers they wrap.
  const onCardOpen = useEventCallback((conversation: MailConversationSummary) =>
    openMailConversation(conversation),
  );
  const onCardAvatarClick = useEventCallback((sender: string, target: HTMLElement) =>
    openAvatarEditor(sender, target),
  );
  const onCardToggleSelected = useEventCallback(
    (conversation: MailConversationSummary, isSelected: boolean) => {
      const conversationMessageIds = conversation.messages.map((item) => item.message_id);
      setSelectedMailMessageIds((current) => {
        if (isSelected) {
          return current.filter((messageId) => !conversationMessageIds.includes(messageId));
        }
        const next = new Set(current);
        for (const messageId of conversationMessageIds) {
          next.add(messageId);
        }
        return Array.from(next);
      });
    },
  );

  function openMailConversation(conversation: MailConversationSummary) {
    setSelectedMailConversationKey(conversation.key);
    openMailMessage(conversation.latestMessage);
  }

  function openMailMessage(message: VisibleMailMessage) {
    messageDetailRequestRef.current += 1;
    closeMailMessageActionMenus();
    setSelectedMailConversationKey(mailConversationKeyForMessage(message));
    if (message.local_folder === "drafts") {
      void openLocalDraftForEditing(message);
      return;
    }
    if (isPendingScheduledSent(message)) {
      void openScheduledSendForEditing(message);
      return;
    }
    setSelectedMailMessageId(message.message_id);
    void loadMessageDetail(message.message_id, true);
  }

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

  function selectMailTaxonomyItem(item: MailTaxonomyItemDto) {
    invalidateMessageDetailRequest();
    setSelectedMailTaxonomyFilter({ kind: item.kind, name: item.name });
    setMailTaxonomySectionExpanded((current) => ({
      ...current,
      [item.kind]: true,
    }));
    setMailboxView(item.kind === "folder" ? "folders" : "labels");
    setRailMode("mail");
    setActiveView("mail");
    setSelectedMailMessageId(null);
    setSelectedMailConversationKey(null);
    setSelectedMessageDetail(null);
    closeMailMessageActionMenus();
  }

  function mailTaxonomyKindLabel(kind: MailTaxonomyKind) {
    return kind === "folder" ? "文件夹" : "标签";
  }

  function mailTaxonomyItemsForKind(kind: MailTaxonomyKind) {
    return kind === "folder" ? mailFolders : mailLabels;
  }

  function isMailTaxonomyDrawerOpen(kind: MailTaxonomyKind) {
    return railCollapsed && mailTaxonomySectionExpanded[kind];
  }

  function resetMailTaxonomyDraft(kind: MailTaxonomyKind) {
    const existingItems = mailTaxonomyItemsForKind(kind);
    setMailTaxonomyEditingId(null);
    setMailTaxonomyDraftName("");
    setMailTaxonomyDraftParentId("");
    setMailTaxonomyDraftColor(mailTaxonomyDefaultColor(kind, existingItems.length));
  }

  function createMailTaxonomyItem(kind: MailTaxonomyKind) {
    rememberModalReturnFocus();
    setMailTaxonomySectionExpanded((current) => ({
      ...current,
      [kind]: true,
    }));
    setMailTaxonomyManagerKind(kind);
    resetMailTaxonomyDraft(kind);
  }

  function toggleMailTaxonomySection(kind: MailTaxonomyKind) {
    setMailTaxonomySectionExpanded((current) => {
      const nextExpanded = !current[kind];
      return kind === "folder"
        ? { folder: nextExpanded, label: false }
        : { folder: false, label: nextExpanded };
    });
  }

  function openMailTaxonomySectionFromIcon(kind: MailTaxonomyKind) {
    if (railCollapsed) {
      setPendingMailTaxonomyAutoOpenKind(kind);
      expandRail();
      return;
    }

    toggleMailTaxonomySection(kind);
  }

  function closeMailTaxonomyManager() {
    setMailTaxonomyManagerKind(null);
    setMailTaxonomyEditingId(null);
    setMailTaxonomyDraftName("");
    setMailTaxonomyDraftParentId("");
  }

  function editMailTaxonomyItem(item: MailTaxonomyItemDto) {
    rememberModalReturnFocus();
    setMailTaxonomyManagerKind(item.kind);
    setMailTaxonomyEditingId(item.id);
    setMailTaxonomyDraftName(item.name);
    setMailTaxonomyDraftParentId(item.kind === "folder" ? item.parent_id ?? "" : "");
    setMailTaxonomyDraftColor(item.color);
  }

  async function submitMailTaxonomyManager(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mailTaxonomyManagerKind) {
      return;
    }
    const name = mailTaxonomyDraftName.trim();
    if (!name) {
      showStatusToast(`${mailTaxonomyKindLabel(mailTaxonomyManagerKind)}名称不能为空。`);
      return;
    }
    try {
      const item = mailTaxonomyEditingId
        ? await mailTaxonomyClient.updateMailTaxonomyItem({
            id: mailTaxonomyEditingId,
            name,
            parent_id:
              mailTaxonomyManagerKind === "folder" ? mailTaxonomyDraftParentId || null : null,
            color: mailTaxonomyDraftColor,
          })
        : await mailTaxonomyClient.upsertMailTaxonomyItem({
            kind: mailTaxonomyManagerKind,
            name,
            parent_id:
              mailTaxonomyManagerKind === "folder" ? mailTaxonomyDraftParentId || null : null,
            color: mailTaxonomyDraftColor,
          });
      await loadMailTaxonomyItems();
      if (mailTaxonomyEditingId) {
        await reloadMailListsAfterLocalAction();
      }
      selectMailTaxonomyItem(item);
      resetMailTaxonomyDraft(mailTaxonomyManagerKind);
      showStatusToast(
        mailTaxonomyEditingId
          ? `已更新${mailTaxonomyKindLabel(item.kind)} ${item.name}。`
          : `已创建${mailTaxonomyKindLabel(item.kind)} ${item.name}。`,
      );
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    }
  }

  async function deleteMailTaxonomyItem(item: MailTaxonomyItemDto) {
    const warning =
      item.kind === "folder"
        ? `删除文件夹“${item.name}”会把其中邮件移回 Inbox。`
        : `删除标签“${item.name}”会从所有邮件中移除此标签。`;
    if (!window.confirm(`${warning}\n\n确定继续？`)) {
      return;
    }
    try {
      const result: MailTaxonomyDeleteDto =
        await mailTaxonomyClient.deleteMailTaxonomyItem({ id: item.id });
      await loadMailTaxonomyItems();
      await reloadMailListsAfterLocalAction();
      if (
        selectedMailTaxonomyFilter?.kind === item.kind &&
        mailTaxonomyItemMatchesName(item, selectedMailTaxonomyFilter.name)
      ) {
        setSelectedMailTaxonomyFilter(null);
      }
      if (mailTaxonomyEditingId === item.id) {
        resetMailTaxonomyDraft(item.kind);
      }
      showStatusToast(
        result.changed
          ? `已删除${mailTaxonomyKindLabel(item.kind)} ${item.name}。`
          : `系统${mailTaxonomyKindLabel(item.kind)} ${item.name} 不能删除。`,
      );
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    }
  }

  function selectNewsletterSubscription(subscription: VisibleNewsletterSubscription) {
    setSelectedNewsletterSubscription((current) =>
      current?.accountId === subscription.account_id &&
      current.subscriptionId === subscription.id
        ? null
        : { accountId: subscription.account_id, subscriptionId: subscription.id },
    );
  }

  async function handleNewsletterSubscriptionHidden(
    subscription: VisibleNewsletterSubscription,
    hidden: boolean,
  ) {
    try {
      await newsletterClient.setNewsletterSubscriptionHidden({
        account_id: subscription.account_id,
        subscription_id: subscription.id,
        hidden,
      });
      await loadNewsletterSubscriptions(subscription.account_id);
      if (hidden) {
        setSelectedNewsletterSubscription((current) =>
          current?.accountId === subscription.account_id &&
          current.subscriptionId === subscription.id
            ? null
            : current,
        );
      }
      showStatusToast(hidden ? "Newsletter subscription hidden." : "Newsletter subscription restored.");
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    }
  }

  function normalizeNewsletterUnsubscribeMethod(method: string) {
    return method.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  }

  async function handleNewsletterUnsubscribe(subscription: VisibleNewsletterSubscription) {
    const method = subscription.unsubscribe_methods
      .map(normalizeNewsletterUnsubscribeMethod)
      .find((value) => value.length > 0);
    if (!method) {
      showStatusToast("No unsubscribe method is available for this newsletter.");
      return;
    }

    try {
      if (/^https?:\/\//i.test(method) || /^mailto:/i.test(method)) {
        await openUrl(method);
        showStatusToast("Opened newsletter unsubscribe method.");
        return;
      }
      await navigator.clipboard.writeText(method);
      showCopyToast("Newsletter unsubscribe method copied.");
    } catch {
      try {
        await navigator.clipboard.writeText(method);
        showCopyToast("Newsletter unsubscribe method copied.");
      } catch {
        showStatusToast("Could not open or copy the unsubscribe method.");
      }
    }
  }

  async function copyVerificationCode(
    event: { stopPropagation: () => void },
    code: string,
  ) {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      showCopyToast(`已复制 ${code}`);
    } catch {
      showCopyToast("复制失败");
    }
  }

  function draftReplyToMail() {
    if (!selectedVisibleMailMessage || !selectedMailMessage) {
      return;
    }

    const realAccountId = selectedVisibleMailMessage.sourceId.startsWith("account:")
      ? selectedVisibleMailMessage.sourceId.slice("account:".length)
      : null;
    if (!realAccountId) {
      setError({
        code: "reply_source_unsupported",
        user_message: "Only long-lived mail accounts can draft replies.",
        correlation_id: "local-validation",
      });
      return;
    }

    const replyAccount = normalImapAccounts.find((account) => account.id === realAccountId) ?? null;
    setSelectedNormalAccountId(realAccountId);

    const subject = selectedMailMessage.subject.trim();
    const originalBody =
      "body_text" in selectedMailMessage
        ? selectedMailMessage.body_text ?? selectedMailMessage.snippet
        : selectedMailMessage.snippet;
    const originalRecipient =
      selectedMailMessage.received_address || replyAccount?.primary_address || realAccountId;

    setSendTargetAddress(extractEmailAddress(selectedMailMessage.from_address));
    setSendSubject(/^re:/i.test(subject) ? subject : `Re: ${subject}`);
    setDraftBodyText(
      [
        "",
        "",
        "--- Original message ---",
        `From: ${selectedMailMessage.from_address}`,
        `To: ${originalRecipient}`,
        `Observed: ${selectedMailMessage.observed_at}`,
        "",
        originalBody,
      ].join("\n"),
    );
    setComposePopoverOpen(true);
    setStatusMessage(
      `Drafted reply from ${replyAccount?.display_name ?? "selected mailbox"}.`,
    );
    setError(null);
  }

  function draftReplyAllToMail() {
    draftReplyToMail();
    if (selectedMailMessage) {
      setStatusMessage("Drafted reply-all using the selected sender account.");
    }
  }

  function draftForwardMail() {
    if (!selectedVisibleMailMessage || !selectedMailMessage) {
      return;
    }

    const realAccountId = selectedVisibleMailMessage.sourceId.startsWith("account:")
      ? selectedVisibleMailMessage.sourceId.slice("account:".length)
      : null;
    if (!realAccountId) {
      setError({
        code: "forward_source_unsupported",
        user_message: "Only long-lived mail accounts can draft forwarded mail.",
        correlation_id: "local-validation",
      });
      return;
    }

    const subject = selectedMailMessage.subject.trim();
    const originalBody =
      "body_text" in selectedMailMessage
        ? selectedMailMessage.body_text ?? selectedMailMessage.snippet
        : selectedMailMessage.snippet;
    const originalRecipient =
      selectedVisibleMailMessage.received_address || selectedMailMessage.received_address || realAccountId;

    setSelectedNormalAccountId(realAccountId);
    setSendTargetAddress("");
    setSendSubject(/^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`);
    setDraftBodyText(
      [
        "",
        "",
        "--- Forwarded message ---",
        `From: ${selectedMailMessage.from_address}`,
        `To: ${originalRecipient}`,
        `Observed: ${selectedMailMessage.observed_at}`,
        "",
        originalBody,
      ].join("\n"),
    );
    setComposePopoverOpen(true);
    setStatusMessage("Drafted forward from the selected mailbox.");
    setError(null);
  }

  function openAdjacentMailMessage(direction: -1 | 1) {
    if (selectedMailMessageIndex < 0) {
      return;
    }
    const adjacentConversation =
      paginatedDisplayedMailConversations[selectedMailMessageIndex + direction] ?? null;
    if (!adjacentConversation) {
      return;
    }
    openMailConversation(adjacentConversation);
  }

  function nextMessageAfterLocalAction() {
    if (selectedMailMessageIndex < 0) {
      return null;
    }
    return (
      paginatedDisplayedMailConversations[selectedMailMessageIndex + 1]?.latestMessage ??
      paginatedDisplayedMailConversations[selectedMailMessageIndex - 1]?.latestMessage ??
      null
    );
  }

  async function reloadMailListsAfterLocalAction() {
    if (mailSourceId === "all") {
      await Promise.all([
        loadAnonymousMessages(),
        ...normalImapAccounts.map((account) => loadNormalMessages(account.id)),
        ...promotedAccounts.map((account) => loadPromotedMessages(account.id)),
      ]);
    } else if (mailSourceId === "temp") {
      await loadAnonymousMessages();
    } else if (mailSourceId.startsWith("account:")) {
      await loadNormalMessages(mailSourceId.slice("account:".length));
    } else if (mailSourceId.startsWith("promoted:")) {
      await loadPromotedMessages(mailSourceId.slice("promoted:".length));
    }
    await loadRecentCodes();
  }

  async function runSelectedMessageLocalAction(
    successMessage: string,
    action: () => Promise<MessageLocalActionDto>,
  ) {
    if (!selectedMailMessage) {
      return;
    }

    const fallbackMessage = nextMessageAfterLocalAction();
    setBusy(true);
    try {
      await action();
      await reloadMailListsAfterLocalAction();
      invalidateMessageDetailRequest();
      setSelectedMessageDetail(null);
      if (fallbackMessage) {
        setSelectedMailMessageId(fallbackMessage.message_id);
        setSelectedMailConversationKey(mailConversationKeyForMessage(fallbackMessage));
        void loadMessageDetail(fallbackMessage.message_id);
      } else {
        setSelectedMailMessageId(null);
        setSelectedMailConversationKey(null);
      }
      setStatusMessage(successMessage);
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedMailMessage() {
    if (!selectedMailMessage) {
      return;
    }

    await runSelectedMessageLocalAction("Moved the message to Trash.", () =>
      invoke<MessageLocalActionDto>("message_delete_local", {
        request: { message_id: selectedMailMessage.message_id },
      }),
    );
  }

  async function deleteSelectedMailMessageForever() {
    if (!selectedMailMessage) {
      return;
    }

    await runSelectedMessageLocalAction("Permanently deleted the message.", () =>
      invoke<MessageLocalActionDto>("message_delete_forever", {
        request: { message_id: selectedMailMessage.message_id },
      }),
    );
  }

  async function restoreSelectedMailMessage() {
    await moveSelectedMailMessage("inbox");
  }

  async function emptyCurrentTrash() {
    const trashMessages = filterVisibleMailMessagesForMailbox(visibleMailMessages, "trash");
    if (trashMessages.length === 0) {
      setStatusMessage("Trash is already empty.");
      return;
    }

    setBusy(true);
    try {
      const result = await invoke<MessageBatchActionDto>("message_empty_trash", {
        request: { message_ids: trashMessages.map((message) => message.message_id) },
      });
      await reloadMailListsAfterLocalAction();
      invalidateMessageDetailRequest();
      setSelectedMailMessageId(null);
      setSelectedMailConversationKey(null);
      setSelectedMessageDetail(null);
      setStatusMessage(
        `Emptied Trash: ${result.changed_count}/${result.requested_count} messages removed.`,
      );
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function setMessageLocalFlag(
    messageId: string,
    flagName: "archived" | "read" | "starred" | "important",
    enabled: boolean,
  ) {
    return invoke<MessageLocalActionDto>("message_set_local_flag", {
      request: {
        message_id: messageId,
        flag_name: flagName,
        enabled,
      },
    });
  }

  function updateCachedVisibleMailMessageLocalFlag(
    messageId: string,
    flagName: "archived" | "read" | "starred" | "important",
    enabled: boolean,
  ) {
    const updateMessage = (message: AnonymousMessageDto): AnonymousMessageDto =>
      message.message_id === messageId
        ? {
            ...message,
            is_read: flagName === "read" ? enabled : message.is_read,
            is_starred: flagName === "starred" ? enabled : message.is_starred,
            is_archived: flagName === "archived" ? enabled : message.is_archived,
            is_important: flagName === "important" ? enabled : message.is_important,
          }
        : message;
    const updateCache = (cache: MessageCache): MessageCache =>
      Object.fromEntries(
        Object.entries(cache).map(([accountId, messages]) => [
          accountId,
          messages.map(updateMessage),
        ]),
      );

    setAnonymousMessages((current) => current.map(updateMessage));
    setNormalMessagesByAccount((current) => updateCache(current));
    setPromotedMessagesByAccount((current) => updateCache(current));
  }

  async function setSelectedMailFlag(
    flagName: "archived" | "read" | "starred" | "important",
    enabled: boolean,
  ) {
    if (!selectedMailMessage) {
      return;
    }

    await setMessageLocalFlag(selectedMailMessage.message_id, flagName, enabled);
    updateCachedVisibleMailMessageLocalFlag(selectedMailMessage.message_id, flagName, enabled);
    setSelectedMessageDetail((current) =>
      current?.message_id === selectedMailMessage.message_id
        ? {
            ...current,
            is_read: flagName === "read" ? enabled : current.is_read,
            is_starred: flagName === "starred" ? enabled : current.is_starred,
            is_archived: flagName === "archived" ? enabled : current.is_archived,
            is_important: flagName === "important" ? enabled : current.is_important,
          }
        : current,
    );
  }

  async function toggleSelectedMailStarred() {
    if (!selectedMailMessage) {
      return;
    }

    const enabled = !selectedMailMessage.is_starred;
    setBusy(true);
    try {
      await setSelectedMailFlag("starred", enabled);
      setStatusMessage(enabled ? "已加入星标邮件。" : "已取消星标邮件。");
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function archiveSelectedMailMessage() {
    await runSelectedMessageLocalAction("Archived the message.", async () => {
      if (!selectedMailMessage) {
        return { message_id: "", changed: false, status: "unchanged", remote_applied: false };
      }
      return setMessageLocalFlag(selectedMailMessage.message_id, "archived", true);
    });
  }

  async function markSelectedMailMessageRead(enabled = true) {
    if (!selectedMailMessage) {
      return;
    }

    setBusy(true);
    try {
      await setSelectedMailFlag("read", enabled);
      await reloadMailListsAfterLocalAction();
      setStatusMessage(enabled ? "Marked the message as read." : "Marked the message as unread.");
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function moveSelectedMailMessage(folderName: string) {
    if (!selectedMailMessage) {
      return;
    }

    setBusy(true);
    try {
      await invoke<MessageLocalActionDto>("message_set_local_folder", {
        request: {
          message_id: selectedMailMessage.message_id,
          folder_name: folderName,
        },
      });
      setSelectedMessageDetail((current) =>
        current?.message_id === selectedMailMessage.message_id
          ? {
              ...current,
              local_folder: normalizeMailToken(folderName),
              is_archived: normalizeMailToken(folderName) === "archive",
            }
          : current,
      );
      await reloadMailListsAfterLocalAction();
      closeMailMessageActionMenus();
      setStatusMessage(`Moved the message to ${folderName}.`);
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function labelSelectedMailMessage(labelName: string, enabled: boolean) {
    if (!selectedMailMessage) {
      return;
    }

    setBusy(true);
    try {
      await invoke<MessageLocalActionDto>("message_set_local_label", {
        request: {
          message_id: selectedMailMessage.message_id,
          label_name: labelName,
          enabled,
        },
      });
      setSelectedMessageDetail((current) => {
        if (current?.message_id !== selectedMailMessage.message_id) {
          return current;
        }
        const labels = enabled
          ? Array.from(new Set([...current.labels, labelName])).sort()
          : current.labels.filter((label) => label !== labelName);
        return { ...current, labels };
      });
      await reloadMailListsAfterLocalAction();
      setStatusMessage(enabled ? `Added label ${labelName}.` : `Removed label ${labelName}.`);
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function enqueueDraftSend() {
    if (!selectedNormalAccountId) {
      setError({
        code: "sender_required",
        user_message: "Select a send-enabled normal account before sending mail.",
        correlation_id: "local-validation",
      });
      return false;
    }
    if (selectedNormalAccountId !== null && isCanonicalNormalAccountId(selectedNormalAccountId)) {
      setError({
        code: "canonical_smtp_unavailable",
        user_message: "Sending from canonical accounts becomes available in M5.",
        correlation_id: "desktop-migration-boundary",
      });
      return false;
    }

    setBusy(true);
    try {
      const senderAccountId = selectedNormalAccountId;
      const persistedDraftId = composePersistedDraftId;
      const scheduledAt = composeScheduledAtIso;
      const targetAddresses = joinComposeAddressList(composeRecipientsForSend("to"));
      const editor = composeBodyEditorRef.current;
      const bodyText = editor ? composeRichBodyHtmlToPlainText(editor) : sendBodyText;
      if (editor) {
        setSendBodyHtml(editor.innerHTML);
        setSendBodyText(bodyText);
      }
      const result = await invoke<SendMessageDto>("send_message", {
        request: {
          account_id: senderAccountId,
          target_address: targetAddresses,
          cc_addresses: composeRecipientsForSend("cc"),
          bcc_addresses: composeRecipientsForSend("bcc"),
          scheduled_at: scheduledAt,
          subject: sendSubject,
          body_text: bodyText,
        },
      });
      setLastSend(result);

      if (!scheduledAt) {
        showStatusToast("正在通过 SMTP 发送邮件...");
        const queueItem = await sendQueueClient.runSendQueueItem({
          queue_id: result.queue_id,
        });
        setLastSendWorkerRun({
          processed_count: queueItem.status === "queued" ? 0 : 1,
          sent_count: queueItem.status === "sent" ? 1 : 0,
          retry_count: queueItem.status === "queued" ? 1 : 0,
          failed_count: queueItem.status === "failed" || queueItem.status === "auth_failed" ? 1 : 0,
        });
        await Promise.all([loadSendQueue(), loadNormalMessages(senderAccountId)]);

        if (queueItem.status !== "sent") {
          const reason =
            queueItem.last_error_message ??
            (queueItem.status === "queued"
              ? "SMTP server did not accept the message yet; it remains queued for retry."
              : `Send queue finished with status ${queueItem.status}.`);
          setError({
            code: queueItem.last_error_code ?? `send_${queueItem.status}`,
            user_message: `邮件尚未发送成功：${reason}`,
            correlation_id: queueItem.id,
          });
          setStatusMessage(`邮件尚未发送成功：${reason}`);
          return false;
        }

        if (persistedDraftId) {
          await invoke<MessageLocalActionDto>("message_delete_local_draft", {
            request: { draft_id: persistedDraftId },
          });
          await loadNormalMessages(senderAccountId);
        }
        showStatusToast(`邮件已发送给 ${targetAddresses}。`);
      } else {
        if (persistedDraftId) {
          await invoke<MessageLocalActionDto>("message_delete_local_draft", {
            request: { draft_id: persistedDraftId },
          });
        }
        await Promise.all([loadSendQueue(), loadNormalMessages(senderAccountId)]);
        showStatusToast(
          `已安排定时发送：${formatComposeScheduleDate(new Date(scheduledAt))}。`,
        );
      }

      setSendTargetAddress("");
      setComposeCcAddress("");
      setComposeBccAddress("");
      setComposeRecipientDrafts({ to: "", cc: "", bcc: "" });
      setComposeCcOpen(false);
      setComposeBccOpen(false);
      setComposeContactPickerField(null);
      setComposeRecipientMenu(null);
      setSendSubject("");
      setDraftBodyText("");
      setComposeSchedulePreset(null);
      setComposeScheduledAtIso(null);
      window.localStorage.removeItem(COMPOSE_DRAFT_STORAGE_KEY);
      setComposeDraftDirty(false);
      setComposeDraftSavedAt(null);
      composeDraftRevisionRef.current += 1;
      composePersistedDraftIdRef.current = null;
      setComposePersistedDraftId(null);
      setError(null);
      return true;
    } catch (caught: unknown) {
      const errorDto = asErrorDto(caught);
      setError(errorDto);
      showStatusToast(`发送失败：${errorDto.user_message}`);
      await loadSendQueue();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runSendQueueWorkerOnce() {
    setBusy(true);
    try {
      const result = await sendQueueClient.runSendQueueOnce();
      setLastSendWorkerRun(result);
      await loadSendQueue();
      setStatusMessage(
        `Send worker processed ${result.processed_count}; sent ${result.sent_count}, retry ${result.retry_count}, failed ${result.failed_count}.`,
      );
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function addAgentAccount() {
    setBusy(true);
    try {
      const account = await invoke<LegacyAccountDto>("agent_add_account", {
        request: {
          display_name: agentDisplayName,
          email_address: agentEmailAddress,
        },
      });
      await loadAgentAccounts();
      setSelectedAgentSenderId(account.id);
      setAgentEmailAddress("");
      setStatusMessage(
        `Added Agent account ${account.display_name}; it is hidden from normal account lists.`,
      );
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function addAgentService() {
    setBusy(true);
    try {
      const service = await invoke<AgentServiceDto>("agent_add_service", {
        request: {
          display_name: agentServiceName,
          email_address: agentServiceEmail,
          description: optionalValue(agentServiceDescription),
          service_kind: "email_agent",
          trust_level: agentTrustLevel,
          default_sender_account_id: selectedAgentSenderId,
        },
      });
      await loadAgentServices();
      setSelectedAgentServiceId(service.id);
      setAgentServiceEmail("");
      setAgentServiceDescription("");
      setStatusMessage(`Added remote Agent service ${service.display_name}.`);
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sendAgentTask() {
    if (!selectedAgentSenderId || !selectedAgentServiceId) {
      setError({
        code: "agent_selection_required",
        user_message: "Select an Agent sender account and remote Agent service before sending.",
        correlation_id: "local-validation",
      });
      return;
    }

    setBusy(true);
    try {
      const result = await invoke<AgentSendTaskDto>("agent_send_task", {
        request: {
          agent_service_id: selectedAgentServiceId,
          sender_account_id: selectedAgentSenderId,
          subject: agentTaskSubject,
          body_text: agentTaskBody,
          confirm_restricted: confirmRestrictedAgent,
        },
      });
      setLastAgentTask(result);
      await Promise.all([loadAgentThreads(), loadSendQueue()]);
      setAgentTaskSubject("");
      setAgentTaskBody("");
      setStatusMessage(
        `Queued Agent task ${result.thread.subject}; queue ${result.queue_id} is ${result.queue_status}.`,
      );
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadAgentThreadDetail(threadId: string) {
    setBusy(true);
    try {
      const detail = await invoke<AgentThreadDetailDto>("agent_get_thread_detail", {
        request: { thread_id: threadId },
      });
      setSelectedAgentThreadDetail(detail);
      setStatusMessage(`Loaded Agent thread ${detail.thread.subject}.`);
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadPromotedMessages(accountId: string | null) {
    if (!accountId) {
      return [];
    }

    const messages = await invoke<AnonymousMessageDto[]>("message_list", {
      request: { scope: "promoted_account", account_id: accountId, include_archived: true },
    });
    setPromotedMessagesByAccount((current) => ({ ...current, [accountId]: messages }));
    return messages;
  }

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

  async function createTempMailbox() {
    setBusy(true);
    try {
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
      const mailboxRecord = temporaryMailboxRecordFromOpenResult(result);
      const coreState = await loadCoreTemporaryState();
      const accounts = await loadNormalAccounts();
      applyCoreTemporaryState(coreState);
      canonicalNormalAccountIdsRef.current = new Set(accounts.map((account) => account.id));
      setNormalAccounts(accounts);
      setSelectedTempMailboxId(mailboxRecord.view.id);
      setTargetService("");
      setNote("");
      if (waitForCode) {
        setWaitingMailboxId(mailboxRecord.view.id);
        setStatusMessage(
          `Created ${mailboxRecord.view.email_address}; waiting for a verification code.`,
        );
      } else {
        setStatusMessage(`Created temporary mailbox ${mailboxRecord.view.email_address}.`);
      }
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
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

  const promotedAccounts = useMemo(
    () => normalAccounts.filter((account) => account.kind === "normal_upgraded_temp"),
    [normalAccounts],
  );
  const normalImapAccounts = useMemo(
    () => normalAccounts.filter((account) => account.kind === "normal_long_lived"),
    [normalAccounts],
  );
  // Normal accounts now come from the canonical core. The legacy Rust SMTP
  // pipeline cannot safely consume those IDs; M5 will expose canonical send.
  const sendEnabledAccounts: AccountDto[] = [];
  const sendEnabledAgentAccounts = useMemo(
    () => agentAccounts.filter((account) => account.send_status === "enabled"),
    [agentAccounts],
  );
  const scheduledSendWorkerTask = useEventCallback(async (isCurrent: () => boolean) => {
      try {
        const result = await sendQueueClient.runSendQueueDueBatch({ limit: 10 });
        if (!isCurrent()) {
          return;
        }
        if (result.processed_count > 0) {
          setLastSendWorkerRun(result);
          await loadSendQueue(isCurrent);
          if (!isCurrent()) {
            return;
          }
          setStatusMessage(
            `Scheduled send worker processed ${result.processed_count}; sent ${result.sent_count}, retry ${result.retry_count}, failed ${result.failed_count}.`,
          );
        }
      } catch (caught: unknown) {
        if (isCurrent()) {
          const errorDto = asErrorDto(caught);
          setStatusMessage(`Scheduled send worker could not run: ${errorDto.user_message}`);
        }
      }
  });
  const runScheduledSendWorker = useMemo(
    () => createNonOverlappingAsyncRunner(scheduledSendWorkerTask),
    [scheduledSendWorkerTask],
  );

  useEffect(() => {
    let cancelled = false;
    const isCurrent = () => !cancelled;

    void runScheduledSendWorker(isCurrent);
    const intervalId = window.setInterval(() => void runScheduledSendWorker(isCurrent), 15000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [runScheduledSendWorker]);

  const selectedAgentService =
    agentServices.find((service) => service.id === selectedAgentServiceId) ?? null;
  const selectedAgentSender =
    agentAccounts.find((account) => account.id === selectedAgentSenderId) ?? null;
  const needsAttentionThreads = agentThreads.filter((thread) => thread.status === "needs_attention");
  const tempVisibleMessages = useMemo(
    () =>
      sortVisibleMailMessagesByTime(
        anonymousMessages.map((message) => ({
          ...message,
          sourceLabel: "临时邮箱",
          sourceId: "temp",
        })),
      ),
    [anonymousMessages],
  );
  const normalVisibleMessages = useMemo(
    () =>
      sortVisibleMailMessagesByTime(
        normalImapAccounts.flatMap((account) =>
          (normalMessagesByAccount[account.id] ?? []).map((message) => ({
            ...message,
            sourceLabel: account.display_name,
            sourceId: `account:${account.id}`,
            account_id: account.id,
          })),
        ),
      ),
    [normalImapAccounts, normalMessagesByAccount],
  );
  const promotedVisibleMessages = useMemo(
    () =>
      sortVisibleMailMessagesByTime(
        promotedAccounts.flatMap((account) =>
          (promotedMessagesByAccount[account.id] ?? []).map((message) => ({
            ...message,
            sourceLabel: account.display_name,
            sourceId: `promoted:${account.id}`,
            account_id: account.id,
          })),
        ),
      ),
    [promotedAccounts, promotedMessagesByAccount],
  );
  const allVisibleMailMessages = useMemo(
    () =>
      sortVisibleMailMessagesByTime([
        ...tempVisibleMessages,
        ...normalVisibleMessages,
        ...promotedVisibleMessages,
      ]),
    [normalVisibleMessages, promotedVisibleMessages, tempVisibleMessages],
  );
  const mailSources: MailSource[] = [
    {
      id: "all",
      label: "全部",
      meta: `${allVisibleMailMessages.length} 封已加载`,
      tone: "signal",
    },
    {
      id: "temp",
      label: "临时",
      meta: `${tempVisibleMessages.length} 封邮件 / ${tempMailboxes.length} 个邮箱`,
      tone: "cyan",
    },
    ...normalImapAccounts.map((account): MailSource => ({
      id: `account:${account.id}`,
      label: account.display_name,
      meta: `${normalMessagesByAccount[account.id]?.length ?? 0} 封邮件 / ${
        account.primary_address ?? account.id
      }`,
      tone: "info",
    })),
    ...promotedAccounts.map((account): MailSource => ({
      id: `promoted:${account.id}`,
      label: account.display_name,
      meta: `${promotedMessagesByAccount[account.id]?.length ?? 0} 封邮件 / ${
        account.primary_address ?? "临时升级邮箱"
      }`,
      tone: "cyan",
    })),
  ];
  const selectedMailSource = mailSources.find((source) => source.id === mailSourceId) ?? mailSources[0];

  function selectMailSource(sourceId: string) {
    invalidateMessageDetailRequest();
    setMailSourceId(sourceId);
    setSelectedMailMessageId(null);
    setSelectedMailConversationKey(null);
    setSelectedMessageDetail(null);
    setSelectedNewsletterSubscription(null);
    setMailSourceDrawerOpen(false);
    setMailSourceDropdownOpen(false);
    if (sourceId.startsWith("account:")) {
      const accountId = sourceId.slice("account:".length);
      setSelectedNormalAccountId(accountId);
      setStatusMessage("This account is HTTP-owned. Message synchronization becomes available in M6.");
      return;
    }
    if (sourceId.startsWith("promoted:")) {
      const accountId = sourceId.slice("promoted:".length);
      void loadPromotedMessages(accountId);
      return;
    }
    if (sourceId === "temp") {
      setSelectedNormalAccountId(null);
    }
  }

  function openMailAccountPanelFromSourceDropdown() {
    rememberModalReturnFocus();
    setMailSourceDropdownOpen(false);
    setMailSourceDrawerOpen(false);
    setMailAccountPanelOpen(true);
  }

  function createTempMailboxFromSourceDropdown() {
    setMailSourceDropdownOpen(false);
    setMailSourceDrawerOpen(false);
    void createTempMailbox();
  }

  async function syncCurrentMailSource(options: { silent?: boolean } = {}) {
    const silent = options.silent === true;
    if (mailAutoSyncInFlightRef.current) {
      if (!silent) {
        showStatusToast("邮件同步正在进行中。");
      }
      return;
    }

    const publishSyncStatus = (message: string) => {
      if (silent) {
        setStatusMessage(message);
      } else {
        showStatusToast(message);
      }
    };

    mailAutoSyncInFlightRef.current = true;
    setMailSyncInProgress(true);
    if (!silent) {
      setBusy(true);
    }
    try {
      if (mailSourceId === "all") {
        const tempResult = await refreshAnonymousMailOnce();
        await Promise.all(promotedAccounts.map((account) => loadPromotedMessages(account.id)));
        const codes = await loadRecentCodes();
        setRecentCodes(codes);

        publishSyncStatus(
          temporaryMailboxRefreshFailureMessage(tempResult) ??
            `Synced available mail: temp fetched ${tempResult.fetched_count}, inserted ${tempResult.inserted_count}; normal-account messages remain unavailable until M6.`,
        );
        const refreshError = temporaryRefreshError(tempResult);
        if (refreshError || !silent) {
          setError(refreshError);
        }
        return;
      }

      if (mailSourceId === "temp") {
        const result = await refreshAnonymousMailOnce();
        publishSyncStatus(
          temporaryMailboxRefreshFailureMessage(result) ??
            `Synced temp mail: fetched ${result.fetched_count}, inserted ${result.inserted_count}.`,
        );
        const refreshError = temporaryRefreshError(result);
        if (refreshError || !silent) {
          setError(refreshError);
        }
        return;
      }

      if (mailSourceId.startsWith("account:")) {
        publishSyncStatus(
          `${selectedMailSource.label} account metadata is current; message synchronization becomes available in M6.`,
        );
        if (!silent) {
          setError(null);
        }
        return;
      }

      if (mailSourceId.startsWith("promoted:")) {
        const accountId = mailSourceId.slice("promoted:".length);
        const messages = await loadPromotedMessages(accountId);
        const codes = await loadRecentCodes();
        setRecentCodes(codes);
        publishSyncStatus(`Reloaded ${selectedMailSource.label}: ${messages.length} historical messages.`);
        if (!silent) {
          setError(null);
        }
        return;
      }

      const result = await refreshAnonymousMailOnce();
      publishSyncStatus(
        temporaryMailboxRefreshFailureMessage(result) ??
          `Synced current source: fetched ${result.fetched_count}, inserted ${result.inserted_count}.`,
      );
      const refreshError = temporaryRefreshError(result);
      if (refreshError || !silent) {
        setError(refreshError);
      }
    } catch (caught: unknown) {
      const errorDto = asErrorDto(caught);
      if (silent) {
        setStatusMessage(`Auto sync failed: ${errorDto.user_message}`);
      } else {
        setError(errorDto);
      }
    } finally {
      mailAutoSyncInFlightRef.current = false;
      setMailSyncInProgress(false);
      if (!silent) {
        setBusy(false);
      }
    }
  }

  const syncCurrentMailSourceEvent = useEventCallback(syncCurrentMailSource);

  useEffect(() => {
    if (activeView !== "mail") {
      return undefined;
    }

    const autoSyncableSource =
      mailSourceId === "all" ||
      mailSourceId === "temp" ||
      mailSourceId.startsWith("promoted:");
    if (!autoSyncableSource) {
      return undefined;
    }

    let disposed = false;
    const runAutoSync = () => {
      if (disposed || mailAutoSyncInFlightRef.current) {
        return;
      }
      void syncCurrentMailSourceEvent({ silent: true });
    };

    const intervalId = window.setInterval(runAutoSync, MAIL_AUTO_SYNC_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [activeView, mailSourceId, syncCurrentMailSourceEvent]);

  const {
    visibleMailMessages,
    mailSearchHasAdvancedCriteria,
    codeBackedMailMessages,
    displayedMailMessages,
    displayedMailConversations,
    displayedMailConversationMessages,
    filteredMailSearchOtherScopes,
    mailSearchAddressOptions,
    mailSearchResultLabel,
    displayedMailMessageKey,
  } = useMemo(() => {
    const visibleMailMessages: VisibleMailMessage[] = (() => {
      if (mailSourceId === "temp") {
        return tempVisibleMessages;
      }
      if (mailSourceId.startsWith("account:")) {
        const accountId = mailSourceId.slice("account:".length);
        const account = normalImapAccounts.find((item) => item.id === accountId) ?? null;
        return sortVisibleMailMessagesByTime(
          (normalMessagesByAccount[accountId] ?? []).map((message) => ({
            ...message,
            sourceLabel: account?.display_name ?? "普通邮箱",
            sourceId: `account:${accountId}`,
            account_id: accountId,
          })),
        );
      }
      if (mailSourceId.startsWith("promoted:")) {
        const accountId = mailSourceId.slice("promoted:".length);
        const account = promotedAccounts.find((item) => item.id === accountId) ?? null;
        return sortVisibleMailMessagesByTime(
          (promotedMessagesByAccount[accountId] ?? []).map((message) => ({
            ...message,
            sourceLabel: account?.display_name ?? "临时升级邮箱",
            sourceId: `promoted:${accountId}`,
            account_id: accountId,
          })),
        );
      }
      return allVisibleMailMessages;
    })();

    const mailboxVisibleMailMessages = filterVisibleMailMessagesForMailbox(
      visibleMailMessages,
      mailboxView,
    );
    const taxonomyVisibleMailMessages =
      selectedMailTaxonomyFilter && mailboxView === "folders" && selectedMailTaxonomyFilter.kind === "folder"
        ? mailboxVisibleMailMessages.filter(
            (message) =>
              normalizeMailToken(message.local_folder) ===
              normalizeMailToken(selectedMailTaxonomyFilter.name),
          )
        : selectedMailTaxonomyFilter && mailboxView === "labels" && selectedMailTaxonomyFilter.kind === "label"
          ? mailboxVisibleMailMessages.filter((message) =>
              message.labels.some((label) =>
                normalizeMailToken(label) === normalizeMailToken(selectedMailTaxonomyFilter.name),
              ),
            )
          : mailboxVisibleMailMessages;
    const subscriptionVisibleMailMessages =
      mailboxView === "newsletters" && selectedNewsletterSubscription
        ? taxonomyVisibleMailMessages.filter(
            (message) =>
              message.account_id === selectedNewsletterSubscription.accountId &&
              message.newsletter_subscription_id === selectedNewsletterSubscription.subscriptionId,
          )
        : taxonomyVisibleMailMessages;
    const mailSearchHasAdvancedCriteria = Boolean(
      mailSearchStartDate ||
        mailSearchEndDate ||
        mailSearchSender ||
        mailSearchRecipient ||
        mailSearchAddress !== "all" ||
        mailSearchHasAttachment,
    );
    const mailSearchIsActive =
      onlyCodes ||
      mailSearchQuery.trim().length > 0 ||
      mailSearchHasAdvancedCriteria ||
      mailSearchScope !== "all-mail";
    const mailSearchBaseMessages = mailSearchIsActive
      ? visibleMailMessages
      : subscriptionVisibleMailMessages;
    const searchScopedMailMessages = mailSearchIsActive
      ? applyMailSearchScopeFilter(mailSearchBaseMessages, mailSearchScope)
      : subscriptionVisibleMailMessages;
    const verificationCodesByMessageId = new Map<string, VerificationCodeDto>();
    for (const code of recentCodes) {
      verificationCodesByMessageId.set(code.message_id, code);
    }
    for (const message of visibleMailMessages) {
      if (!verificationCodesByMessageId.has(message.message_id)) {
        const inlineCode = detectInlineVerificationCode(message);
        if (inlineCode) {
          verificationCodesByMessageId.set(message.message_id, inlineCode);
        }
      }
    }
    const expandedVerificationCodes = Array.from(verificationCodesByMessageId.values());
    const codeBackedMailMessages: CodeBackedMailMessage[] = searchScopedMailMessages.flatMap(
      (message) => {
        const verificationCode = verificationCodesByMessageId.get(message.message_id);
        return verificationCode ? [{ ...message, verificationCode }] : [];
      },
    );
    const mailSearchAdvancedFilters = {
      query: mailSearchQuery,
      fullText: mailSearchFullText,
      startDate: mailSearchStartDate,
      endDate: mailSearchEndDate,
      sender: mailSearchSender,
      recipient: mailSearchRecipient,
      address: mailSearchAddress,
      hasAttachment: mailSearchHasAttachment,
    };
    const filteredMailMessages = searchScopedMailMessages.filter((message) =>
      mailSearchMessageMatchesAdvancedFilters(message, mailSearchAdvancedFilters),
    );
    const filteredCodeBackedMailMessages = codeBackedMailMessages.filter((message) => {
      if (!mailSearchMessageMatchesAdvancedFilters(message, mailSearchAdvancedFilters)) {
        return false;
      }
      const query = mailSearchQuery.trim().toLowerCase();
      if (!query) {
        return true;
      }
      return [
        message.verificationCode.code,
        message.verificationCode.issuer_hint ?? "",
        message.verificationCode.target_service_hint ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query) ||
        visibleMailMessageSearchText(message, mailSearchFullText).includes(query);
    });
    const mailListBaseMessages = onlyCodes
      ? filteredCodeBackedMailMessages
      : filteredMailMessages;
    const mailListFilteredMessages = mailListBaseMessages.filter((message) => {
      if (mailListReadFilter === "unread" && message.is_read) {
        return false;
      }
      if (mailListReadFilter === "read" && !message.is_read) {
        return false;
      }
      if (mailListHasAttachmentOnly && !visibleMailMessageHasAttachment(message)) {
        return false;
      }
      return true;
    });
    const displayedMailMessages = sortMailListMessages(
      mailListFilteredMessages,
      mailListSortMode,
    );
    const mailConversationMatchedMessageIds = new Set(
      displayedMailMessages.map((message) => message.message_id),
    );
    const mailConversationSourceMessages = onlyCodes
      ? displayedMailMessages
      : sortMailListMessages(searchScopedMailMessages, mailListSortMode);
    const displayedMailConversations = buildMailConversations(
      mailConversationSourceMessages,
      verificationCodesByMessageId,
      mailListSortMode,
    ).filter((conversation) =>
      conversation.messages.some((message) =>
        mailConversationMatchedMessageIds.has(message.message_id),
      ),
    );
    const displayedMailConversationMessages = displayedMailConversations.flatMap(
      (conversation) => conversation.messages,
    );
    const selectedMailSearchScope =
      [...MAIL_SEARCH_PRIMARY_SCOPES, ...MAIL_SEARCH_OTHER_SCOPES].find(
        (scope) => scope.id === mailSearchScope,
      ) ?? MAIL_SEARCH_PRIMARY_SCOPES[0];
    const normalizedMailSearchFolderFilter = mailSearchFolderFilter.trim().toLowerCase();
    const filteredMailSearchOtherScopes = normalizedMailSearchFolderFilter
      ? MAIL_SEARCH_OTHER_SCOPES.filter((scope) =>
          `${scope.label} ${scope.id}`.toLowerCase().includes(normalizedMailSearchFolderFilter),
        )
      : MAIL_SEARCH_OTHER_SCOPES;
    const mailSearchAddressOptions = [
      { id: "all", label: "全部" },
      ...normalImapAccounts.map((account) => ({
        id: account.primary_address?.toLowerCase() ?? account.id.toLowerCase(),
        label: account.primary_address ?? account.display_name,
      })),
      ...promotedAccounts.map((account) => ({
        id: account.primary_address?.toLowerCase() ?? account.id.toLowerCase(),
        label: account.primary_address ?? account.display_name,
      })),
    ];
    const mailSearchResultLabel = onlyCodes
      ? `${displayedMailMessages.length} / ${expandedVerificationCodes.length} 条验证码结果 · ${selectedMailSearchScope.label}`
      : mailSearchQuery.trim() || mailSearchHasAdvancedCriteria
        ? `${displayedMailMessages.length} 条结果 · ${selectedMailSearchScope.label}`
        : "搜索邮件";
    const displayedMailMessageKey = displayedMailConversationMessages
      .map((message) => message.message_id)
      .join("|");

    return {
      visibleMailMessages,
      mailSearchHasAdvancedCriteria,
      codeBackedMailMessages,
      displayedMailMessages,
      displayedMailConversations,
      displayedMailConversationMessages,
      filteredMailSearchOtherScopes,
      mailSearchAddressOptions,
      mailSearchResultLabel,
      displayedMailMessageKey,
    };
  }, [
    allVisibleMailMessages,
    mailListHasAttachmentOnly,
    mailListReadFilter,
    mailListSortMode,
    mailSearchAddress,
    mailSearchEndDate,
    mailSearchFolderFilter,
    mailSearchFullText,
    mailSearchHasAttachment,
    mailSearchQuery,
    mailSearchRecipient,
    mailSearchScope,
    mailSearchSender,
    mailSearchStartDate,
    mailboxView,
    mailSourceId,
    normalImapAccounts,
    normalMessagesByAccount,
    onlyCodes,
    promotedAccounts,
    promotedMessagesByAccount,
    recentCodes,
    selectedMailTaxonomyFilter,
    selectedNewsletterSubscription,
    tempVisibleMessages,
  ]);

  // Pagination depends only on the grouped conversations and the active page, so
  // turning a page must not re-run the filter/sort/group pipeline above.
  const {
    mailListTotalPages,
    clampedMailListCurrentPage,
    mailListPageStart,
    mailListPageEnd,
    paginatedDisplayedMailConversations,
    paginatedDisplayedMailMessages,
  } = useMemo(
    () =>
      paginateMailConversations(displayedMailConversations, mailListCurrentPage, MAIL_LIST_PAGE_SIZE),
    [displayedMailConversations, mailListCurrentPage],
  );
  const paginatedCodeBackedMailMessages =
    paginatedDisplayedMailMessages as CodeBackedMailMessage[];

  // Selection state changes on every checkbox click, which is why it is kept out
  // of the derivation memo above.
  const {
    selectedMailMessageIdsSet,
    mailListActionMessageIds,
    mailListHasSelection,
    selectedMailMessagesHaveUnread,
    mailListPrimaryMoveActions,
    allVisibleMailMessageIds,
    allVisibleMailMessagesSelected,
    someVisibleMailMessagesSelected,
  } = useMemo(() => {
    const selectedMailMessageIdsSet = new Set(selectedMailMessageIds);
    const mailListCheckedSelection = selectedMailMessageIds.length > 0;
    const mailListActionMessageIds = mailListCheckedSelection
      ? selectedMailMessageIds
      : selectedMailMessageId
        ? [selectedMailMessageId]
        : [];
    const selectedMailMessagesForActions = mailListActionMessageIds
      .map(
        (messageId) =>
          displayedMailMessages.find((message) => message.message_id === messageId) ?? null,
      )
      .filter((message): message is VisibleMailMessage => message !== null);
    const mailListHasSelection = mailListCheckedSelection;
    const selectedMailMessagesHaveUnread = selectedMailMessagesForActions.some(
      (message) => !message.is_read,
    );
    const mailListPrimaryMoveActions: MailListPrimaryMoveAction[] = (() => {
      switch (mailboxView) {
        case "archive":
          return ["trash", "inbox", "spam"];
        case "spam":
          return ["trash", "nospam", "delete"];
        case "trash":
          return ["inbox", "archive", "delete"];
        case "drafts":
        case "sent":
          return ["trash", "archive", "delete"];
        default:
          return ["trash", "archive", "spam"];
      }
    })();
    const allVisibleMailMessageIds = paginatedDisplayedMailMessages.map(
      (message) => message.message_id,
    );
    const allVisibleMailMessagesSelected =
      allVisibleMailMessageIds.length > 0 &&
      allVisibleMailMessageIds.every((messageId) =>
        selectedMailMessageIdsSet.has(messageId),
      );
    const someVisibleMailMessagesSelected =
      allVisibleMailMessageIds.some((messageId) =>
        selectedMailMessageIdsSet.has(messageId),
      ) && !allVisibleMailMessagesSelected;

    return {
      selectedMailMessageIdsSet,
      mailListActionMessageIds,
      mailListHasSelection,
      selectedMailMessagesHaveUnread,
      mailListPrimaryMoveActions,
      allVisibleMailMessageIds,
      allVisibleMailMessagesSelected,
      someVisibleMailMessagesSelected,
    };
  }, [
    displayedMailMessages,
    mailboxView,
    paginatedDisplayedMailMessages,
    selectedMailMessageId,
    selectedMailMessageIds,
  ]);
  // Memoized because this ran on every render, allocating a fresh object per
  // subscription each time. Those new identities would also defeat any
  // memoization downstream of them.
  const {
    displayedNewsletterSubscriptions,
    hiddenNewsletterSubscriptionCount,
  } = useMemo(() => {
    const allDisplayedNewsletterSubscriptions: VisibleNewsletterSubscription[] =
      mailboxView === "newsletters"
        ? mailSourceId.startsWith("account:")
          ? (newsletterSubscriptionsByAccount[mailSourceId.slice("account:".length)] ?? []).map(
              (subscription) => ({
                ...subscription,
                account_id: mailSourceId.slice("account:".length),
              }),
            )
          : normalImapAccounts.flatMap(
              (account) =>
                (newsletterSubscriptionsByAccount[account.id] ?? []).map((subscription) => ({
                  ...subscription,
                  account_id: account.id,
                })),
            )
        : [];

    return {
      displayedNewsletterSubscriptions: allDisplayedNewsletterSubscriptions.filter(
        (subscription) => showHiddenNewsletterSubscriptions || !subscription.hidden,
      ),
      hiddenNewsletterSubscriptionCount: allDisplayedNewsletterSubscriptions.filter(
        (subscription) => subscription.hidden,
      ).length,
    };
  }, [
    mailSourceId,
    mailboxView,
    newsletterSubscriptionsByAccount,
    normalImapAccounts,
    showHiddenNewsletterSubscriptions,
  ]);

  useEffect(() => {
    if (mailListCurrentPage !== clampedMailListCurrentPage) {
      setMailListCurrentPage(clampedMailListCurrentPage);
    }
  }, [clampedMailListCurrentPage, mailListCurrentPage]);

  useEffect(() => {
    setSelectedMailMessageIds((current) =>
      current.filter((messageId) =>
        displayedMailConversationMessages.some((message) => message.message_id === messageId),
      ),
    );
  }, [displayedMailMessageKey, displayedMailConversationMessages]);

  useEffect(() => {
    setMailListCurrentPage(0);
  }, [mailSourceId, mailboxView, onlyCodes, mailSearchQuery, mailSearchScope, mailSearchStartDate, mailSearchEndDate, mailSearchSender, mailSearchRecipient, mailSearchAddress, mailSearchHasAttachment, mailListReadFilter, mailListHasAttachmentOnly, mailListSortMode, selectedMailTaxonomyFilter, selectedNewsletterSubscription]);

  useEffect(() => {
    setMailListSelectionMenuOpen(false);
    setMailListBulkMenuOpen(false);
    setMailListFilterMenuOpen(false);
    setMailListMoveMenuOpen(false);
    setMailListLabelMenuOpen(false);
    setMailListSnoozeMenuOpen(false);
    setMailListMoveTarget("");
    setMailListLabelDraftIds([]);
  }, [mailSourceId, mailboxView, selectedMailTaxonomyFilter, selectedNewsletterSubscription]);

  useEffect(() => {
    const selectedIsVisible =
      selectedMailConversationKey !== null
        ? paginatedDisplayedMailConversations.some(
            (conversation) => conversation.key === selectedMailConversationKey,
          )
        : selectedMailMessageId !== null &&
          paginatedDisplayedMailConversations.some((conversation) =>
            conversation.messages.some((message) => message.message_id === selectedMailMessageId),
          );

    if (selectedIsVisible) {
      return;
    }

    const nextConversation = paginatedDisplayedMailConversations[0] ?? null;
    if (!nextConversation) {
      messageDetailRequestRef.current += 1;
      if (selectedMailMessageId !== null) {
        setSelectedMailMessageId(null);
      }
      if (selectedMailConversationKey !== null) {
        setSelectedMailConversationKey(null);
      }
      if (selectedMessageDetail !== null) {
        setSelectedMessageDetail(null);
      }
      return;
    }

    setSelectedMailConversationKey(nextConversation.key);
    setSelectedMailMessageId(nextConversation.latestMessage.message_id);
    void loadMessageDetail(nextConversation.latestMessage.message_id);
  }, [
    displayedMailMessageKey,
    paginatedDisplayedMailConversations,
    selectedMailConversationKey,
    selectedMailMessageId,
    selectedMessageDetail,
  ]);

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

  function selectMailSearchScope(scope: MailSearchScope) {
    setMailSearchScope(scope);
    setMailSearchOtherMenuOpen(false);
    setMailSearchFolderFilter("");
  }

  function resetMailSearchOptions() {
    setMailSearchQuery("");
    setMailSearchScope("all-mail");
    setMailSearchFullText(true);
    setMailSearchStartDate("");
    setMailSearchEndDate("");
    setMailSearchSender("");
    setMailSearchRecipient("");
    setMailSearchAddress("all");
    setMailSearchHasAttachment(false);
    setMailSearchOtherMenuOpen(false);
    setMailSearchFolderFilter("");
  }

  function closeMailSearchOverlay() {
    setMailSearchOverlayOpen(false);
    setMailSearchOtherMenuOpen(false);
    setMailSearchFolderFilter("");
  }

  function submitMailSearch(event?: FormEvent) {
    event?.preventDefault();
    closeMailSearchOverlay();
  }

  function setMailListReadFilterAndClose(nextFilter: MailListReadFilter) {
    setMailListReadFilter(nextFilter);
    setMailListCurrentPage(0);
    setMailListFilterMenuOpen(false);
  }

  function toggleMailListUnreadOnly() {
    setMailListReadFilter(mailListReadFilter === "unread" ? "all" : "unread");
    setMailListCurrentPage(0);
    setMailListFilterMenuOpen(false);
  }

  function setMailListSortModeAndClose(nextSortMode: MailListSortMode) {
    setMailListSortMode(nextSortMode);
    setMailListFilterMenuOpen(false);
  }

  function closeMailMessageActionMenus() {
    setMailMoveMenuOpen(false);
    setMailLabelMenuOpen(false);
    setMailMessageMoreMenuOpen(false);
  }

  function closeMailListToolbarMenus() {
    setMailListSelectionMenuOpen(false);
    setMailListBulkMenuOpen(false);
    setMailListFilterMenuOpen(false);
    setMailListMoveMenuOpen(false);
    setMailListLabelMenuOpen(false);
    setMailListSnoozeMenuOpen(false);
  }

  function toggleMailMessageSelection(messageId: string) {
    setSelectedMailMessageIds((current) =>
      current.includes(messageId)
        ? current.filter((currentId) => currentId !== messageId)
        : [...current, messageId],
    );
  }

  function toggleSelectAllVisibleMailMessages() {
    setSelectedMailMessageIds((current) => {
      if (allVisibleMailMessagesSelected) {
        return current.filter((messageId) => !allVisibleMailMessageIds.includes(messageId));
      }
      return Array.from(new Set([...current, ...allVisibleMailMessageIds]));
    });
  }

  function replaceSelectionFromPredicate(
    predicate: (message: VisibleMailMessage) => boolean,
  ) {
    setSelectedMailMessageIds(displayedMailMessages.filter(predicate).map((message) => message.message_id));
    setMailListSelectionMenuOpen(false);
  }

  function clearMailMessageSelection() {
    setSelectedMailMessageIds([]);
    setMailListSelectionMenuOpen(false);
    setMailListBulkMenuOpen(false);
    setMailListMoveMenuOpen(false);
    setMailListLabelMenuOpen(false);
    setMailListSnoozeMenuOpen(false);
  }

  function goToMailListPage(nextPage: number) {
    setMailListCurrentPage(Math.max(0, Math.min(mailListTotalPages - 1, nextPage)));
  }

  function visibleMessageById(messageId: string) {
    return displayedMailMessages.find((message) => message.message_id === messageId) ?? null;
  }

  async function runBatchMailActions(
    successMessage: string,
    action: (message: VisibleMailMessage) => Promise<unknown>,
  ) {
    const selectedMessages = mailListActionMessageIds
      .map((messageId) => visibleMessageById(messageId))
      .filter((message): message is VisibleMailMessage => message !== null);

    if (selectedMessages.length === 0) {
      showStatusToast("请先选择要处理的邮件。");
      return;
    }

    setBusy(true);
    try {
      await Promise.all(selectedMessages.map((message) => action(message)));
      await reloadMailListsAfterLocalAction();
      invalidateMessageDetailRequest();
      setSelectedMailMessageIds([]);
      setMailListSelectionMenuOpen(false);
      setMailListBulkMenuOpen(false);
      setMailListFilterMenuOpen(false);
      setMailListMoveMenuOpen(false);
      setMailListLabelMenuOpen(false);
      setMailListSnoozeMenuOpen(false);
      setSelectedMessageDetail(null);
      setSelectedMailMessageId(null);
      setSelectedMailConversationKey(null);
      showStatusToast(successMessage.replace("{count}", String(selectedMessages.length)));
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function archiveSelectedMailMessages() {
    await runBatchMailActions("已归档 {count} 封邮件。", (message) =>
      setMessageLocalFlag(message.message_id, "archived", true),
    );
  }

  async function markSelectedMailMessagesRead(enabled: boolean) {
    await runBatchMailActions(enabled ? "已标记 {count} 封邮件为已读。" : "已标记 {count} 封邮件为未读。", (message) =>
      setMessageLocalFlag(message.message_id, "read", enabled),
    );
  }

  async function trashSelectedMailMessages() {
    await runBatchMailActions("已移至回收站 {count} 封邮件。", (message) =>
      invoke<MessageLocalActionDto>("message_delete_local", {
        request: { message_id: message.message_id },
      }),
    );
  }

  async function deleteSelectedMailMessagesForever() {
    await runBatchMailActions("已彻底删除 {count} 封邮件。", (message) =>
      invoke<MessageLocalActionDto>("message_delete_forever", {
        request: { message_id: message.message_id },
      }),
    );
  }

  async function runDisplayedMailActions(
    successMessage: string,
    action: (message: VisibleMailMessage) => Promise<unknown>,
  ) {
    const targetMessages = displayedMailMessages;
    if (targetMessages.length === 0) {
      showStatusToast("当前列表没有可处理的邮件。");
      return;
    }

    setBusy(true);
    try {
      await Promise.all(targetMessages.map((message) => action(message)));
      await reloadMailListsAfterLocalAction();
      invalidateMessageDetailRequest();
      setSelectedMailMessageIds([]);
      setSelectedMessageDetail(null);
      setSelectedMailMessageId(null);
      setSelectedMailConversationKey(null);
      closeMailListToolbarMenus();
      showStatusToast(successMessage.replace("{count}", String(targetMessages.length)));
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function moveAllDisplayedMailMessagesToTrash() {
    await runDisplayedMailActions("已将 {count} 封邮件全部移至回收站。", (message) =>
      invoke<MessageLocalActionDto>("message_delete_local", {
        request: { message_id: message.message_id },
      }),
    );
  }

  async function archiveAllDisplayedMailMessages() {
    await runDisplayedMailActions("已归档 {count} 封邮件。", (message) =>
      setMessageLocalFlag(message.message_id, "archived", true),
    );
  }

  async function moveSelectedMailMessages(folderName: string) {
    await runBatchMailActions(`已将 {count} 封邮件移至 ${folderName}。`, (message) =>
      invoke<MessageLocalActionDto>("message_set_local_folder", {
        request: {
          message_id: message.message_id,
          folder_name: folderName,
        },
      }),
    );
  }

  async function applyMailListMoveTarget() {
    const target = mailListMoveTarget.trim();
    if (!target) {
      showStatusToast("请选择要移动到的文件夹。");
      return;
    }

    if (target.startsWith("folder:")) {
      const folder = localFolderOptions.find((item) => item.id === target.slice("folder:".length));
      if (!folder) {
        showStatusToast("目标文件夹不存在。");
        return;
      }
      await moveSelectedMailMessages(folder.name);
    } else if (target === "trash") {
      await trashSelectedMailMessages();
    } else if (target === "archive") {
      await archiveSelectedMailMessages();
    } else {
      await moveSelectedMailMessages(target);
    }
    setMailListMoveTarget("");
    setMailListMoveSearch("");
  }

  function toggleMailListLabelDraft(labelId: string) {
    setMailListLabelDraftIds((current) =>
      current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId],
    );
  }

  function resetMailListLabelDraftFromSelection() {
    const selectedMessages = selectedMailMessageIds
      .map((messageId) => visibleMessageById(messageId))
      .filter((message): message is VisibleMailMessage => message !== null);

    setMailListLabelDraftIds(
      localLabelOptions
        .filter((label) =>
          selectedMessages.every((message) =>
            message.labels.some((value) => normalizeMailToken(value) === normalizeMailToken(label.name)),
          ),
        )
        .map((label) => label.id),
    );
  }

  async function applyMailListLabelDraft() {
    const selectedMessages = selectedMailMessageIds
      .map((messageId) => visibleMessageById(messageId))
      .filter((message): message is VisibleMailMessage => message !== null);

    if (selectedMessages.length === 0) {
      showStatusToast("请先选择要处理的邮件。");
      return;
    }

    setBusy(true);
    try {
      const operations: Promise<unknown>[] = [];
      localLabelOptions.forEach((label) => {
        const shouldEnable = mailListLabelDraftIds.includes(label.id);
        const enabledForAll = selectedMessages.every((message) =>
          message.labels.some((value) => normalizeMailToken(value) === normalizeMailToken(label.name)),
        );
        if (shouldEnable === enabledForAll) {
          return;
        }
        selectedMessages.forEach((message) => {
          operations.push(
            invoke<MessageLocalActionDto>("message_set_local_label", {
              request: {
                message_id: message.message_id,
                label_name: label.name,
                enabled: shouldEnable,
              },
            }),
          );
        });
      });

      if (mailListLabelArchiveAfterApply) {
        selectedMessages.forEach((message) => {
          operations.push(setMessageLocalFlag(message.message_id, "archived", true));
        });
      }

      if (operations.length === 0) {
        setMailListLabelMenuOpen(false);
        showStatusToast("标签未发生变化。");
        return;
      }

      await Promise.all(operations);
      await reloadMailListsAfterLocalAction();
      invalidateMessageDetailRequest();
      setSelectedMailMessageIds([]);
      setMailListLabelMenuOpen(false);
      setMailListLabelSearch("");
      setMailListLabelArchiveAfterApply(false);
      setSelectedMessageDetail(null);
      setSelectedMailMessageId(null);
      setSelectedMailConversationKey(null);
      showStatusToast(`已更新 ${selectedMessages.length} 封邮件的标签。`);
      setError(null);
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  async function snoozeSelectedMailMessages(label: string) {
    await runBatchMailActions(`已将 {count} 封邮件推迟到${label}。`, (message) =>
      invoke<MessageLocalActionDto>("message_set_local_folder", {
        request: {
          message_id: message.message_id,
          folder_name: "later",
        },
      }),
    );
  }

  function renderMailListPrimaryMoveAction(action: MailListPrimaryMoveAction) {
    const config: Record<
      MailListPrimaryMoveAction,
      {
        icon: "inbox" | "trash" | "archive" | "spam" | "nospam" | "delete";
        ariaLabel: string;
        title: string;
        run: () => void;
      }
    > = {
      inbox: {
        icon: "inbox",
        ariaLabel: "将选中邮件移至收件箱",
        title: "移至收件箱",
        run: () => void moveSelectedMailMessages("inbox"),
      },
      trash: {
        icon: "trash",
        ariaLabel: "将选中邮件移至回收站",
        title: "移至回收站",
        run: () => void trashSelectedMailMessages(),
      },
      archive: {
        icon: "archive",
        ariaLabel: "归档选中邮件",
        title: "归档",
        run: () => void archiveSelectedMailMessages(),
      },
      spam: {
        icon: "spam",
        ariaLabel: "将选中邮件移至垃圾邮件",
        title: "移至垃圾邮件",
        run: () => void moveSelectedMailMessages("spam"),
      },
      nospam: {
        icon: "nospam",
        ariaLabel: "将选中邮件移出垃圾邮件",
        title: "不是垃圾邮件",
        run: () => void moveSelectedMailMessages("inbox"),
      },
      delete: {
        icon: "delete",
        ariaLabel: "永久删除选中邮件",
        title: "彻底删除",
        run: () => void deleteSelectedMailMessagesForever(),
      },
    };
    const item = config[action];

    return (
      <button
        type="button"
        key={action}
        className="nt-mail-list-toolbar__action"
        aria-label={item.ariaLabel}
        title={item.title}
        onClick={item.run}
        disabled={busy}
      >
        <MailListToolbarIcon kind={item.icon} />
      </button>
    );
  }

  function renderMailListSelectionMenu() {
    if (!mailListSelectionMenuOpen) {
      return null;
    }

    return (
      <div
        id="mail-list-selection-menu"
        className="nt-mail-list-toolbar__menu nt-mail-list-toolbar__menu--selection"
        role="menu"
        aria-label="选择邮件"
        data-nonmodal-layer="mail-list-selection"
      >
        <button type="button" role="menuitem" onClick={toggleSelectAllVisibleMailMessages}>
          {allVisibleMailMessagesSelected ? "取消本页全选" : "全选"}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => replaceSelectionFromPredicate((message) => !message.is_read)}
        >
          所有未读邮件
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => replaceSelectionFromPredicate((message) => message.is_read)}
        >
          所有已读邮件
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => replaceSelectionFromPredicate((message) => message.is_starred)}
        >
          所有星标邮件
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => replaceSelectionFromPredicate((message) => !message.is_starred)}
        >
          所有非星标邮件
        </button>
        <button type="button" role="menuitem" onClick={clearMailMessageSelection}>
          清空选择
        </button>
      </div>
    );
  }

  function renderMailListMoreMenu() {
    if (!mailListBulkMenuOpen) {
      return null;
    }

    return (
      <div
        id="mail-list-more-menu"
        className="nt-mail-list-toolbar__menu nt-mail-list-toolbar__menu--more"
        role="menu"
        aria-label="更多邮箱操作"
        data-nonmodal-layer="mail-list-more"
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => void moveAllDisplayedMailMessagesToTrash()}
          disabled={busy}
        >
          <MailListToolbarIcon kind="trash" />
          全部移至回收站
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => void archiveAllDisplayedMailMessages()}
          disabled={busy}
        >
          <MailListToolbarIcon kind="archive" />
          全部归档
        </button>
      </div>
    );
  }

  function renderMailListMoveMenu() {
    if (!mailListMoveMenuOpen) {
      return null;
    }

    const normalizedMoveSearch = mailListMoveSearch.trim().toLowerCase();
    const builtInMoveOptions: Array<{
      id: string;
      label: string;
      icon: "inbox" | "archive" | "spam" | "trash";
    }> = [
      { id: "inbox", label: "收件箱", icon: "inbox" },
      { id: "archive", label: "归档", icon: "archive" },
      { id: "spam", label: "垃圾邮件", icon: "spam" },
      { id: "trash", label: "移至回收站", icon: "trash" },
    ];
    const filteredBuiltInMoveOptions = builtInMoveOptions.filter((option) =>
      normalizedMoveSearch ? option.label.toLowerCase().includes(normalizedMoveSearch) : true,
    );
    const filteredCustomMoveOptions = localFolderOptions.filter((folder) =>
      normalizedMoveSearch ? folder.name.toLowerCase().includes(normalizedMoveSearch) : true,
    );

    return (
      <div
        id="mail-list-move-panel"
        className="nt-mail-list-toolbar__panel nt-mail-list-toolbar__panel--move"
        role="dialog"
        aria-label="移动选中邮件"
        data-nonmodal-layer="mail-list-move"
      >
        <div className="nt-mail-list-toolbar__panel-head">
          <strong>移动到</strong>
          <button
            type="button"
            className="nt-mail-list-toolbar__create"
            aria-label="新建文件夹"
            onClick={() => {
              closeMailListToolbarMenus();
              createMailTaxonomyItem("folder");
            }}
          >
            <MailListToolbarIcon kind="move" />
            <span>+</span>
          </button>
        </div>
        <label className="nt-mail-list-toolbar__panel-search">
          <SearchMagnifierIcon />
          <input
            data-nonmodal-initial-focus
            value={mailListMoveSearch}
            placeholder="搜索文件夹"
            aria-label="搜索文件夹"
            onChange={(event) => setMailListMoveSearch(event.currentTarget.value)}
          />
        </label>
        <div className="nt-mail-list-toolbar__panel-options" role="radiogroup" aria-label="移动目标">
          {filteredBuiltInMoveOptions.map((option) => (
            <button
              type="button"
              key={option.id}
              className={`nt-mail-list-toolbar__panel-option ${
                mailListMoveTarget === option.id ? "nt-mail-list-toolbar__panel-option--active" : ""
              }`}
              role="radio"
              aria-checked={mailListMoveTarget === option.id}
              onClick={() => setMailListMoveTarget(option.id)}
            >
              <span className="nt-mail-list-toolbar__radio" aria-hidden="true" />
              <MailListToolbarIcon kind={option.icon} />
              <span>{option.label}</span>
            </button>
          ))}
          {filteredCustomMoveOptions.map((folder) => {
            const targetId = `folder:${folder.id}`;
            return (
              <button
                type="button"
                key={folder.id}
                className={`nt-mail-list-toolbar__panel-option ${
                  mailListMoveTarget === targetId ? "nt-mail-list-toolbar__panel-option--active" : ""
                }`}
                role="radio"
                aria-checked={mailListMoveTarget === targetId}
                onClick={() => setMailListMoveTarget(targetId)}
              >
                <span className="nt-mail-list-toolbar__radio" aria-hidden="true" />
                <span
                  className="nt-mail-list-toolbar__menu-color"
                  style={{ "--taxonomy-color": folder.color } as CSSProperties}
                  aria-hidden="true"
                />
                <span>{folder.name}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="nt-mail-list-toolbar__apply"
          onClick={() => void applyMailListMoveTarget()}
          disabled={!mailListMoveTarget || busy}
        >
          应用
        </button>
      </div>
    );
  }

  function renderMailListLabelMenu() {
    if (!mailListLabelMenuOpen) {
      return null;
    }

    const normalizedLabelSearch = mailListLabelSearch.trim().toLowerCase();
    const filteredLocalLabelOptions = localLabelOptions.filter((label) =>
      normalizedLabelSearch ? label.name.toLowerCase().includes(normalizedLabelSearch) : true,
    );

    return (
      <div
        id="mail-list-label-panel"
        className="nt-mail-list-toolbar__panel nt-mail-list-toolbar__panel--label"
        role="dialog"
        aria-label="为选中邮件添加标签"
        data-nonmodal-layer="mail-list-label"
      >
        <div className="nt-mail-list-toolbar__panel-head">
          <strong>加标签</strong>
          <button
            type="button"
            className="nt-mail-list-toolbar__create"
            aria-label="新建标签"
            onClick={() => {
              closeMailListToolbarMenus();
              createMailTaxonomyItem("label");
            }}
          >
            <MailListToolbarIcon kind="label" />
            <span>+</span>
          </button>
        </div>
        <label className="nt-mail-list-toolbar__panel-search">
          <SearchMagnifierIcon />
          <input
            data-nonmodal-initial-focus
            value={mailListLabelSearch}
            placeholder="搜索标签"
            aria-label="搜索标签"
            onChange={(event) => setMailListLabelSearch(event.currentTarget.value)}
          />
        </label>
        <div className="nt-mail-list-toolbar__panel-options" role="group" aria-label="标签选项">
          {filteredLocalLabelOptions.length === 0 ? (
            <div
              className="nt-mail-list-toolbar__empty"
              role="status"
              aria-live="polite"
              data-empty-state
            >
              暂无匹配标签
            </div>
          ) : (
            filteredLocalLabelOptions.map((label) => {
              const checked = mailListLabelDraftIds.includes(label.id);
              return (
                <button
                  type="button"
                  key={label.id}
                  className={`nt-mail-list-toolbar__panel-option ${
                    checked ? "nt-mail-list-toolbar__panel-option--active" : ""
                  }`}
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggleMailListLabelDraft(label.id)}
                >
                  <span className="nt-mail-list-toolbar__checkbox" aria-hidden="true">
                    {checked ? "✓" : ""}
                  </span>
                  <span
                    className="nt-mail-list-toolbar__menu-color"
                    style={{ "--taxonomy-color": label.color } as CSSProperties}
                    aria-hidden="true"
                  />
                  <span>{label.name}</span>
                </button>
              );
            })
          )}
        </div>
        <label className="nt-mail-list-toolbar__option-check">
          <input
            type="checkbox"
            checked={mailListLabelArchiveAfterApply}
            onChange={(event) => setMailListLabelArchiveAfterApply(event.currentTarget.checked)}
          />
          <span>同时归档</span>
        </label>
        <button
          type="button"
          className="nt-mail-list-toolbar__apply"
          onClick={() => void applyMailListLabelDraft()}
          disabled={busy}
        >
          应用
        </button>
      </div>
    );
  }

  function renderMailListSnoozeMenu() {
    if (!mailListSnoozeMenuOpen) {
      return null;
    }

    return (
      <div
        id="mail-list-snooze-panel"
        className="nt-mail-list-toolbar__panel nt-mail-list-toolbar__panel--snooze"
        role="dialog"
        aria-label="推迟选中邮件"
        data-nonmodal-layer="mail-list-snooze"
      >
        <div className="nt-mail-list-toolbar__snooze-head">
          <strong>推迟邮件通知</strong>
          <span>您希望此邮件何时重新出现在您的收件箱中?</span>
        </div>
        <button type="button" className="nt-mail-list-toolbar__snooze-row" onClick={() => void snoozeSelectedMailMessages("明天上午 9:00")}>
          <span>明天</span>
          <span>上午 9:00</span>
        </button>
        <button type="button" className="nt-mail-list-toolbar__snooze-row" onClick={() => void snoozeSelectedMailMessages("本周末上午 9:00")}>
          <span>本周末</span>
          <span>周六 上午 9:00</span>
        </button>
        <button type="button" className="nt-mail-list-toolbar__snooze-row" onClick={() => void snoozeSelectedMailMessages("下一周上午 9:00")}>
          <span>下一周</span>
          <span>周一 上午 9:00</span>
        </button>
        <button type="button" className="nt-mail-list-toolbar__snooze-custom" onClick={() => void snoozeSelectedMailMessages("自定义时间")}>
          <span>请选择日期与时间</span>
          <span className="nt-mail-list-toolbar__snooze-plus">
            <MailListToolbarIcon kind="mark-read" />
            +
          </span>
        </button>
      </div>
    );
  }

  function renderMailListFilterMenu() {
    if (!mailListFilterMenuOpen) {
      return null;
    }

    return (
      <div
        id="mail-list-filter-menu"
        className="nt-mail-list-toolbar__menu nt-mail-list-toolbar__menu--filter"
        role="menu"
        aria-label="筛选和排序"
        data-nonmodal-layer="mail-list-filter"
      >
        <strong>筛选</strong>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mailListReadFilter === "unread"}
          className={mailListReadFilter === "unread" ? "nt-mail-list-toolbar__menu-item--active" : ""}
          onClick={() => setMailListReadFilterAndClose("unread")}
        >
          未读
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mailListReadFilter === "read"}
          className={mailListReadFilter === "read" ? "nt-mail-list-toolbar__menu-item--active" : ""}
          onClick={() => setMailListReadFilterAndClose("read")}
        >
          已读
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={mailListHasAttachmentOnly}
          className={mailListHasAttachmentOnly ? "nt-mail-list-toolbar__menu-item--active" : ""}
          onClick={() => {
            setMailListHasAttachmentOnly((current) => !current);
            setMailListFilterMenuOpen(false);
          }}
        >
          包含附件
        </button>
        <span className="nt-mail-list-toolbar__divider" role="separator" />
        <strong>排序</strong>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mailListSortMode === "newest"}
          className={mailListSortMode === "newest" ? "nt-mail-list-toolbar__menu-item--active" : ""}
          onClick={() => setMailListSortModeAndClose("newest")}
        >
          从新到旧
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mailListSortMode === "oldest"}
          className={mailListSortMode === "oldest" ? "nt-mail-list-toolbar__menu-item--active" : ""}
          onClick={() => setMailListSortModeAndClose("oldest")}
        >
          从旧到新
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mailListSortMode === "largest"}
          className={mailListSortMode === "largest" ? "nt-mail-list-toolbar__menu-item--active" : ""}
          onClick={() => setMailListSortModeAndClose("largest")}
        >
          从大到小
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mailListSortMode === "smallest"}
          className={mailListSortMode === "smallest" ? "nt-mail-list-toolbar__menu-item--active" : ""}
          onClick={() => setMailListSortModeAndClose("smallest")}
        >
          从小到大
        </button>
      </div>
    );
  }

  const platformAccount = platformSession?.account ?? null;
  const platformAccountInitial = platformAccount?.avatar_initial ?? "N";
  const platformAccountName = platformAccount?.display_name ?? "NMail 开发预览账户";
  const platformAccountEmail = platformAccount?.email ?? "dev.user@nmail.local";
  const platformAccountPopoverTitle = platformAccountSignedIn
    ? platformAccountName
    : "NMail 平台账户";
  const platformAccountPopoverEmail = platformAccountSignedIn
    ? platformAccountEmail
    : "当前未登录平台账户";
  const platformAccountMeta =
    !platformAccountSignedIn
      ? "已退出登录"
      : error !== null
      ? error.user_message
      : lastPlatformQuery !== null
        ? `最近查询：${lastPlatformQuery.resource} / ${lastPlatformQuery.status}`
        : platformSession === null
      ? "正在加载开发预览会话"
          : `开发预览 · ${platformSession.server_kind} / ${platformSession.auth_mode}`;
  const activeRailModeLabel = railMode === "mail" ? "Mail" : "Agent";
  const queueRailBadgeCount = sendQueue.filter((item) => item.status !== "sent").length;
  const agentRailBadgeCount = agentThreads.filter((thread) => thread.status === "needs_attention").length;
  const mailRailCounts = useMemo(() => buildMailRailCounts(visibleMailMessages), [visibleMailMessages]);
  const {
    mailFolderStats,
    mailLabelStats,
    mailFolderTreeItems,
    mailTaxonomyParentOptions,
  } = useMemo(() => {
    const folderStatsByKey = new Map<string, { total: number; unread: number }>();
    const labelStatsByKey = new Map<string, { total: number; unread: number }>();
    for (const message of visibleMailMessages) {
      const folderKey = normalizeMailToken(message.local_folder);
      const folderStats = folderStatsByKey.get(folderKey) ?? { total: 0, unread: 0 };
      folderStats.total += 1;
      if (!message.is_read) folderStats.unread += 1;
      folderStatsByKey.set(folderKey, folderStats);

      const messageLabelKeys = new Set(message.labels.map(normalizeMailToken));
      for (const labelKey of messageLabelKeys) {
        const labelStats = labelStatsByKey.get(labelKey) ?? { total: 0, unread: 0 };
        labelStats.total += 1;
        if (!message.is_read) labelStats.unread += 1;
        labelStatsByKey.set(labelKey, labelStats);
      }
    }
    const mailFolderStats = new Map(
      mailFolders.map((folder) => [
        folder.name,
        folderStatsByKey.get(normalizeMailToken(folder.name)) ?? { total: 0, unread: 0 },
      ] as const),
    );
    const mailLabelStats = new Map(
      mailLabels.map((labelItem) => [
        labelItem.name,
        labelStatsByKey.get(normalizeMailToken(labelItem.name)) ?? { total: 0, unread: 0 },
      ] as const),
    );
    const mailFolderTreeItems = buildMailTaxonomyFolderTree(mailFolders);
    const mailTaxonomyParentOptions = mailFolderTreeItems.filter(({ item }) => {
      if (!mailTaxonomyEditingId) {
        return true;
      }
      return (
        item.id !== mailTaxonomyEditingId &&
        !isMailTaxonomyFolderDescendant(mailFolders, item.id, mailTaxonomyEditingId)
      );
    });

    return {
      mailFolderStats,
      mailLabelStats,
      mailFolderTreeItems,
      mailTaxonomyParentOptions,
    };
  }, [
    mailFolders,
    mailLabels,
    mailTaxonomyEditingId,
    visibleMailMessages,
  ]);
  function renderMailTaxonomyFolderItems() {
    return mailFolderTreeItems.map(({ item: folder, depth }) => {
      const stats = mailFolderStats.get(folder.name);
      const active =
        mailboxView === "folders" &&
        selectedMailTaxonomyFilter?.kind === "folder" &&
        mailTaxonomyItemMatchesName(folder, selectedMailTaxonomyFilter.name);
      const badge = formatRailBadgeCount(stats?.unread ?? 0);
      return (
        <button
          key={folder.id}
          type="button"
          className={`nt-mail-taxonomy__item nt-mail-taxonomy__item--folder ${
            active ? "nt-mail-taxonomy__item--active" : ""
          }`}
          onClick={() => selectMailTaxonomyItem(folder)}
          title={folder.name}
          style={{ "--taxonomy-depth": depth } as CSSProperties}
        >
          <span
            className="nt-mail-taxonomy__folder-icon"
            style={{ "--taxonomy-color": folder.color } as CSSProperties}
            aria-hidden="true"
          />
          <span className="nt-mail-taxonomy__name nt-rail-text">{folder.name}</span>
          {badge ? <span className="nt-mail-taxonomy__badge">{badge}</span> : null}
        </button>
      );
    });
  }

  function renderMailTaxonomyLabelItems() {
    return mailLabels.map((labelItem) => {
      const stats = mailLabelStats.get(labelItem.name);
      const active =
        mailboxView === "labels" &&
        selectedMailTaxonomyFilter?.kind === "label" &&
        mailTaxonomyItemMatchesName(labelItem, selectedMailTaxonomyFilter.name);
      const badge = formatRailBadgeCount(stats?.unread ?? 0);
      return (
        <button
          key={labelItem.id}
          type="button"
          className={`nt-mail-taxonomy__item nt-mail-taxonomy__item--label ${
            active ? "nt-mail-taxonomy__item--active" : ""
          }`}
          onClick={() => selectMailTaxonomyItem(labelItem)}
          title={labelItem.name}
        >
          <span
            className="nt-mail-taxonomy__dot"
            style={{ "--taxonomy-color": labelItem.color } as CSSProperties}
            aria-hidden="true"
          />
          <span className="nt-mail-taxonomy__name nt-rail-text">{labelItem.name}</span>
          {badge ? <span className="nt-mail-taxonomy__badge">{badge}</span> : null}
        </button>
      );
    });
  }
  const selectedMailboxLabel =
    selectedMailTaxonomyFilter?.name ??
    (mailboxView === "folders" ? "Folders" : mailboxView === "labels" ? "Labels" : null) ??
    MAIL_RAIL_ITEMS.find((item) => item.id === mailboxView)?.label ??
    "Inbox";
  const agentRailBadge = formatRailBadgeCount(agentRailBadgeCount);
  const queueRailBadge = formatRailBadgeCount(queueRailBadgeCount);
  // Another full scan of every visible message, previously run on each render.
  const trashMessageCount = useMemo(
    () => filterVisibleMailMessagesForMailbox(visibleMailMessages, "trash").length,
    [visibleMailMessages],
  );
  const localLabelOptions = mailLabels;
  const localFolderOptions = mailFolders;
  const avatarEditorAvatar = avatarEditor ? senderAvatarFor(avatarEditor.sender) : null;
  const avatarEditorHasCustomIcon = avatarEditorAvatar?.source_kind === "contact";

  function nodeIsInsideComposeEditor(node: Node | null) {
    const editor = composeBodyEditorRef.current;
    return !!editor && !!node && (node === editor || editor.contains(node));
  }

  function saveComposeEditorSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      nodeIsInsideComposeEditor(range.commonAncestorContainer) ||
      nodeIsInsideComposeEditor(range.startContainer) ||
      nodeIsInsideComposeEditor(range.endContainer)
    ) {
      composeSavedSelectionRangeRef.current = range.cloneRange();
    }
  }

  function restoreComposeEditorSelection() {
    const editor = composeBodyEditorRef.current;
    if (!editor) {
      return false;
    }
    editor.focus({ preventScroll: true });
    const range = composeSavedSelectionRangeRef.current;
    if (!range || !nodeIsInsideComposeEditor(range.startContainer) || !nodeIsInsideComposeEditor(range.endContainer)) {
      return false;
    }
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function preserveComposeEditorSelection(event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    restoreComposeEditorSelection();
  }

  function focusComposeBody() {
    const editor = composeBodyEditorRef.current;
    if (!editor) {
      return;
    }
    editor.focus({ preventScroll: true });
  }

  function syncComposeRichBodyState() {
    const editor = composeBodyEditorRef.current;
    if (!editor) {
      return;
    }
    setSendBodyHtml(editor.innerHTML);
    setSendBodyText(composeRichBodyHtmlToPlainText(editor));
    refreshComposeActiveFormats();
  }

  function refreshComposeActiveFormats() {
    const editor = composeBodyEditorRef.current;
    const selection = window.getSelection();
    const selectionNode = selection?.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
    if (!editor || !selectionNode || !editor.contains(selectionNode)) {
      return;
    }
    const element =
      selectionNode.nodeType === Node.ELEMENT_NODE
        ? (selectionNode as Element)
        : selectionNode.parentElement;
    setComposeActiveFormats({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      strike: document.queryCommandState("strikeThrough"),
      unorderedList: document.queryCommandState("insertUnorderedList"),
      orderedList: document.queryCommandState("insertOrderedList"),
      quote: !!element?.closest("blockquote"),
    });
  }

  function composeFormatButtonClass(key: keyof ComposeActiveFormats) {
    return composeActiveFormats[key]
      ? "nt-compose-format-button nt-compose-format-button--active"
      : "nt-compose-format-button";
  }

  function applyComposeAiRewrite(kind: "formalize" | "friendly") {
    setComposeAiMoreMenuOpen(false);
    if (kind === "formalize") {
      insertComposeRichText("请将选中文本改写得更正式。");
      return;
    }
    insertComposeRichText("请将选中文本改写得更友好。");
  }

  function renderComposeAiMoreMenu() {
    if (!composeAiMoreMenuOpen) {
      return null;
    }
    return (
      <div
        id="compose-ai-more-menu"
        className="nt-compose-popover__more-menu nt-compose-ai-more-menu"
        role="menu"
        aria-label="更多 AI 写作操作"
        data-nonmodal-layer="compose-ai-more"
      >
        <button type="button" role="menuitem" onClick={() => applyComposeAiRewrite("formalize")}>
          正式化
        </button>
        <button type="button" role="menuitem" onClick={() => applyComposeAiRewrite("friendly")}>
          使它变得友好
        </button>
      </div>
    );
  }

  function renderComposeMoreMenu(anchor: ComposeMoreMenuAnchor) {
    if (!composeMoreMenuOpen || composeMoreMenuAnchor !== anchor) {
      return null;
    }
    const anchorClass =
      anchor === "formatbar"
        ? "nt-compose-popover__more-menu--formatbar"
        : "nt-compose-popover__more-menu--toolbar";
    return (
      <div
        id="compose-more-menu"
        className={`nt-compose-popover__more-menu ${anchorClass}`}
        role="menu"
        aria-label="更多格式操作"
        data-nonmodal-layer="compose-more"
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setComposeMoreMenuOpen(false);
            composeImageInputRef.current?.click();
          }}
        >
          插入图片
        </button>
        <button type="button" role="menuitem" onClick={() => applyComposeRichCommand("direction-ltr")}>
          {composeTextDirection === "ltr" ? "✓ " : ""}从左到右
        </button>
        <button type="button" role="menuitem" onClick={() => applyComposeRichCommand("direction-rtl")}>
          {composeTextDirection === "rtl" ? "✓ " : ""}从右到左
        </button>
      </div>
    );
  }

  function composeRichBodyHtmlToPlainText(editor: HTMLElement): string {
    return editor.innerText.replace(/\u00a0/g, " ");
  }

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

  function handleComposeRichInput(_event: FormEvent<HTMLDivElement>) {
    saveComposeEditorSelection();
    syncComposeRichBodyState();
    setComposeDraftDirty(true);
  }

  function handleComposeRichPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    const pastedHtml = event.clipboardData.getData("text/html");
    const pastedText = event.clipboardData.getData("text/plain");
    if (!pastedHtml && !pastedText) {
      return;
    }
    event.preventDefault();
    if (pastedHtml) {
      document.execCommand("insertHTML", false, sanitizeComposeHtml(pastedHtml));
    } else {
      document.execCommand("insertText", false, pastedText);
    }
    saveComposeEditorSelection();
    syncComposeRichBodyState();
    setComposeDraftDirty(true);
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

  function insertComposeRichHtml(html: string) {
    restoreComposeEditorSelection();
    document.execCommand("insertHTML", false, sanitizeComposeHtml(html));
    syncComposeRichBodyState();
  }

  function insertComposeRichText(text: string) {
    restoreComposeEditorSelection();
    document.execCommand("insertText", false, text);
    syncComposeRichBodyState();
  }

  function composeSelectedTextForAi() {
    restoreComposeEditorSelection();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return "";
    }
    const range = selection.getRangeAt(0);
    if (
      !nodeIsInsideComposeEditor(range.commonAncestorContainer) &&
      !nodeIsInsideComposeEditor(range.startContainer) &&
      !nodeIsInsideComposeEditor(range.endContainer)
    ) {
      return "";
    }
    return selection.toString().replace(/\s+/g, " ").trim();
  }

  function expandComposeAiText(text: string) {
    const source = text.trim();
    const quotedSource = source.length > 120 ? `${source.slice(0, 120).trim()}...` : source;
    return `关于“${quotedSource}”，我想进一步补充说明：这部分内容可以从背景、原因和后续安排三个角度展开。首先，它体现了当前需要重点处理的问题；其次，我们会结合实际情况补充更多细节，让表达更完整、更自然；最后，也希望对方能够清楚理解我们的目标，并据此推进下一步沟通。`;
  }

  function applyComposeAiExpandSelection() {
    const selectedText = composeSelectedTextForAi();
    if (!selectedText) {
      setStatusMessage("请先选择一段短文本，然后点击展开。");
      return;
    }
    document.execCommand("insertText", false, expandComposeAiText(selectedText));
    syncComposeRichBodyState();
    setStatusMessage("已将选中文本扩写为更完整的润色草稿。");
  }

  function composeBlockForNode(node: Node): HTMLElement | null {
    const editor = composeBodyEditorRef.current;
    if (!editor) {
      return null;
    }
    const element =
      node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const listItem = element?.closest("li");
    if (listItem && editor.contains(listItem)) {
      return listItem as HTMLElement;
    }
    const block = element?.closest("blockquote,p,div,h1,h2,h3,h4,h5,h6");
    if (block && block !== editor && editor.contains(block)) {
      return block as HTMLElement;
    }
    return editor;
  }

  function selectedComposeAlignmentBlocks(range: Range) {
    const editor = composeBodyEditorRef.current;
    const blocks = new Set<HTMLElement>();
    if (!editor) {
      return [];
    }
    const addBlock = (node: Node) => {
      const block = composeBlockForNode(node);
      if (block) {
        blocks.add(block);
      }
    };
    addBlock(range.startContainer);
    addBlock(range.endContainer);
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      const element = node as HTMLElement;
      if (
        element !== editor &&
        element.matches("li,blockquote,p,div,h1,h2,h3,h4,h5,h6") &&
        range.intersectsNode(element)
      ) {
        const listItem = element.closest("li");
        blocks.add(listItem && editor.contains(listItem) ? (listItem as HTMLElement) : element);
      }
      node = walker.nextNode();
    }
    return Array.from(blocks);
  }

  function applyComposeListMarkerAlignment(block: HTMLElement, alignment: ComposeAlignmentValue) {
    if (!block.matches("li")) {
      return;
    }
    block.style.listStylePosition = alignment === "left" ? "outside" : "inside";
  }

  function applyComposeAlignmentToBlocks(alignment: ComposeAlignmentValue) {
    restoreComposeEditorSelection();
    const selection = window.getSelection();
    const editor = composeBodyEditorRef.current;
    if (!selection || selection.rangeCount === 0 || !editor) {
      return;
    }
    const range = selection.getRangeAt(0);
    const blocks = selectedComposeAlignmentBlocks(range);
    (blocks.length > 0 ? blocks : [editor]).forEach((block) => {
      block.style.textAlign = alignment;
      applyComposeListMarkerAlignment(block, alignment);
    });
    saveComposeEditorSelection();
    syncComposeRichBodyState();
  }

  function closeComposeFormattingPopovers() {
    setComposeFontMenuOpen(false);
    setComposeFontSizeMenuOpen(false);
    setComposeColorMenuOpen(false);
    setComposeAlignmentMenuOpen(false);
    setComposeEmojiPickerOpen(false);
    setComposeMoreMenuOpen(false);
    setComposeAiMoreMenuOpen(false);
    setComposeBottomMoreOpen(false);
    setComposeEncryptionMenuOpen(false);
    setComposeScheduleSendOpen(false);
    setComposeEncryptionModalOpen(false);
    setComposeExpirationModalOpen(false);
  }

  function chooseComposeFont(label: string) {
    setComposeFontFamily(label);
    setComposeFontMenuOpen(false);
    focusComposeBody();
    document.execCommand("fontName", false, composeFontCss(label));
    syncComposeRichBodyState();
  }

  function pxToLegacyFontSize(size: string): string {
    const px = Number.parseInt(size, 10);
    if (px <= 10) return "1";
    if (px <= 12) return "2";
    if (px <= 16) return "3";
    if (px <= 18) return "4";
    if (px <= 22) return "5";
    if (px <= 24) return "6";
    return "7";
  }

  function normalizeComposeFontSizeNodes(size: string) {
    const editor = composeBodyEditorRef.current;
    if (!editor) {
      return;
    }
    editor.querySelectorAll("font[size]").forEach((node) => {
      if (node.getAttribute("size") !== pxToLegacyFontSize(size)) {
        return;
      }
      node.removeAttribute("size");
      (node as HTMLElement).style.fontSize = size;
    });
    syncComposeRichBodyState();
  }

  function applyComposeTextStyle(style: Partial<CSSStyleDeclaration>) {
    const selection = window.getSelection();
    const editor = composeBodyEditorRef.current;
    if (!editor || !selection || selection.rangeCount === 0) {
      return false;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      return false;
    }
    if (range.collapsed) {
      return false;
    }
    const span = document.createElement("span");
    Object.assign(span.style, style);
    try {
      range.surroundContents(span);
    } catch {
      span.appendChild(range.extractContents());
      range.insertNode(span);
    }
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(span);
    selection.addRange(nextRange);
    syncComposeRichBodyState();
    return true;
  }

  function applyComposeBackgroundColor(color: string) {
    focusComposeBody();
    if (applyComposeTextStyle({ backgroundColor: color })) {
      return;
    }
    document.execCommand("backColor", false, color);
    syncComposeRichBodyState();
  }

  function chooseComposeFontSize(size: string) {
    setComposeFontSize(size);
    setComposeFontSizeMenuOpen(false);
    focusComposeBody();
    document.execCommand("fontSize", false, pxToLegacyFontSize(size));
    normalizeComposeFontSizeNodes(size);
  }

  function chooseComposeColor(color: string) {
    if (composeColorMode === "text") {
      setComposeTextColor(color);
      focusComposeBody();
      document.execCommand("foreColor", false, color);
      syncComposeRichBodyState();
    } else {
      setComposeBackgroundColor(color);
      applyComposeBackgroundColor(color);
    }
  }

  function openComposeLinkModal() {
    rememberModalReturnFocus();
    closeComposeFormattingPopovers();
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    setComposeLinkType("web");
    setComposeLinkUrl("");
    setComposeLinkText(selectedText);
    setComposeLinkModalOpen(true);
  }

  function submitComposeLinkModal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const href = normalizedComposeLinkHref;
    const label = composeLinkText.trim();
    if (!href || !label) {
      showStatusToast("请输入有效的网页、电子邮件地址或电话号码链接。");
      return;
    }
    setComposeLinkModalOpen(false);
    focusComposeBody();
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    if (!selectedText) {
      document.execCommand("insertText", false, label);
    }
    document.execCommand("createLink", false, href);
    syncComposeRichBodyState();
  }

  function insertComposeEmoji(emoji: string) {
    setComposeEmojiPickerOpen(false);
    insertComposeRichText(emoji);
  }

  // This walks every emoji category, and ran on every render of App() even with
  // the picker closed - so a keystroke in the mail search box paid for it.
  const filteredComposeEmojiCategories = useMemo(
    () => filterComposeEmojiCategories(composeEmojiSearch, composeEmojiActiveCategoryId),
    [composeEmojiSearch, composeEmojiActiveCategoryId],
  );

  function handleComposeImageFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }
    const validation = validateComposeImageFile(file);
    if (!validation.valid) {
      showStatusToast(validation.message);
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        insertComposeRichHtml(buildComposeImageHtml(reader.result, file.name));
      }
    });
    reader.addEventListener("error", () => {
      showStatusToast("图片读取失败，请重试。");
    });
    reader.readAsDataURL(file);
  }

  function applyComposeRichCommand(command: string) {
    setComposeMoreMenuOpen(false);
    setComposeFontMenuOpen(false);
    setComposeFontSizeMenuOpen(false);
    setComposeColorMenuOpen(false);
    setComposeAlignmentMenuOpen(false);
    restoreComposeEditorSelection();
    if (command === "bold") {
      document.execCommand("bold", false);
    } else if (command === "italic") {
      document.execCommand("italic", false);
    } else if (command === "underline") {
      document.execCommand("underline", false);
    } else if (command === "strike") {
      document.execCommand("strikeThrough", false);
    } else if (command === "unordered-list") {
      document.execCommand("insertUnorderedList", false);
    } else if (command === "ordered-list") {
      document.execCommand("insertOrderedList", false);
    } else if (command === "quote") {
      document.execCommand("formatBlock", false, "blockquote");
    } else if (command === "emoji") {
      setComposeEmojiPickerOpen((value) => !value);
      return;
    } else if (command === "link") {
      openComposeLinkModal();
      return;
    } else if (command === "align-left") {
      applyComposeAlignmentToBlocks("left");
      return;
    } else if (command === "align-center") {
      applyComposeAlignmentToBlocks("center");
      return;
    } else if (command === "align-right") {
      applyComposeAlignmentToBlocks("right");
      return;
    } else if (command === "direction-ltr") {
      composeBodyEditorRef.current?.setAttribute("dir", "ltr");
      setComposeTextDirection("ltr");
    } else if (command === "direction-rtl") {
      composeBodyEditorRef.current?.setAttribute("dir", "rtl");
      setComposeTextDirection("rtl");
    } else if (command === "remove-format") {
      document.execCommand("removeFormat", false);
      document.execCommand("unlink", false);
    } else if (command === "ai") {
      insertComposeRichText("【模板预览】请基于当前主题起草一封更完整的邮件。");
      return;
    } else if (command === "review") {
      insertComposeRichHtml(
        "<p>审阅清单：</p><ul><li>语气是否合适</li><li>表达是否清晰</li><li>行动请求是否明确</li></ul>",
      );
      return;
    } else if (command === "signature") {
      insertComposeRichHtml("<p><br></p><p>此致<br>NMail</p>");
      return;
    } else if (command === "clear") {
      setComposeRichBodyFromPlainText("");
      focusComposeBody();
      return;
    }
    syncComposeRichBodyState();
  }

  function openComposePopover() {
    composeDraftRevisionRef.current += 1;
    setRailMode("mail");
    setRailModePickerOpen(false);
    closeMailSearchOverlay();
    closeMailListToolbarMenus();
    setMailSourceDropdownOpen(false);
    composeDraftHydratedRef.current = false;
    setComposePopoverOpen(true);
    setComposePopoverMinimized(false);
  }

  function closeComposePopover() {
    composeDraftRevisionRef.current += 1;
    closeComposeFormattingPopovers();
    setComposePopoverOpen(false);
    setComposePopoverMinimized(false);
    setComposeContactPickerField(null);
    setComposeContactPickerPosition(null);
  }

  function contactPickerPositionFromTrigger(
    trigger: HTMLButtonElement,
  ): ComposeContactPickerPosition {
    const rect = trigger.getBoundingClientRect();
    const pickerWidth = 360;
    const viewportPadding = 16;
    const left = Math.max(
      viewportPadding,
      Math.min(rect.left - 260, window.innerWidth - pickerWidth - viewportPadding),
    );
    return {
      left,
      top: rect.bottom + 8,
    };
  }

  function toggleComposeContactPicker(
    field: ComposeRecipientField,
    event?: ReactMouseEvent<HTMLButtonElement>,
  ) {
    if (field === "cc") {
      setComposeCcOpen(true);
    }
    if (field === "bcc") {
      setComposeBccOpen(true);
    }
    if (contacts.length === 0) {
      openContactModal(field, composeRecipientDrafts[field]);
      return;
    }
    setComposeRecipientMenu(null);
    if (composeContactPickerField === field) {
      setComposeContactPickerField(null);
      setComposeContactPickerPosition(null);
      return;
    }
    if (event) {
      setComposeContactPickerPosition(contactPickerPositionFromTrigger(event.currentTarget));
    }
    setComposeContactPickerField(field);
  }

  function resetContactDraft() {
    setContactDraftFirstName("");
    setContactDraftLastName("");
    setContactDraftDisplayName("");
    setContactDraftEmail("");
    setContactDraftPhone("");
    setContactDraftAddress("");
    setContactDraftBirthday("");
    setContactDraftOrganization("");
    setContactDraftTitle("");
    setContactDraftNote("");
  }

  function openContactModal(
    field: ComposeRecipientField | null = composeContactPickerField,
    seedEmail = "",
  ) {
    rememberModalReturnFocus();
    setContactDraftTargetField(field);
    setComposeContactPickerField(null);
    setComposeContactPickerPosition(null);
    setComposeRecipientMenu(null);
    resetContactDraft();
    const normalizedSeed = extractEmailAddress(seedEmail).toLowerCase();
    if (normalizedSeed.length > 0) {
      setContactDraftEmail(normalizedSeed);
      setContactDraftDisplayName(displayNameFromAddress(normalizedSeed));
    }
    setContactModalOpen(true);
  }

  function closeContactModal() {
    setContactModalOpen(false);
    setContactDraftTargetField(null);
    setComposeContactPickerPosition(null);
    resetContactDraft();
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

  function setRecipientValueForField(
    field: ComposeRecipientField,
    updater: (current: string) => string,
  ) {
    if (field === "to") {
      setSendTargetAddress(updater);
    } else if (field === "cc") {
      setComposeCcAddress(updater);
    } else {
      setComposeBccAddress(updater);
    }
  }

  function setRecipientDraftForField(field: ComposeRecipientField, value: string) {
    setComposeRecipientDrafts((current) => ({ ...current, [field]: value }));
  }

  function composeRecipientsForSend(field: ComposeRecipientField) {
    const committed = recipientValueForField(field);
    const draft = composeRecipientDrafts[field];
    return parseComposeAddressList([committed, draft].filter(Boolean).join(", "));
  }

  function commitComposeRecipientDraft(field: ComposeRecipientField, rawValue = composeRecipientDrafts[field]) {
    const tokens = parseComposeAddressList(rawValue);
    if (tokens.length === 0) {
      return;
    }
    setRecipientValueForField(field, (current) =>
      tokens.reduce((next, token) => appendComposeRecipientValue(next, token), current),
    );
    setRecipientDraftForField(field, "");
    setComposeRecipientMenu(null);
  }

  function handleComposeRecipientDraftChange(field: ComposeRecipientField, value: string) {
    const parts = value.split(/([;,\s]+)/);
    const committedTokens: string[] = [];
    let draft = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      if (/^[;,\s]+$/.test(part)) {
        if (draft.trim().length > 0) {
          committedTokens.push(draft);
          draft = "";
        }
      } else {
        draft += part;
      }
    }

    if (committedTokens.length > 0) {
      setRecipientValueForField(field, (current) =>
        committedTokens.reduce((next, token) => appendComposeRecipientValue(next, token), current),
      );
    }
    setRecipientDraftForField(field, draft);
  }

  function handleComposeRecipientDraftKeyDown(
    field: ComposeRecipientField,
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) {
    if (
      event.key === "," ||
      event.key === " " ||
      event.key === "Enter" ||
      event.key === "Tab"
    ) {
      const draft = composeRecipientDrafts[field].trim();
      if (draft.length > 0) {
        event.preventDefault();
        commitComposeRecipientDraft(field, draft);
      }
    }
  }

  function removeComposeRecipient(field: ComposeRecipientField, address: string) {
    const normalized = extractEmailAddress(address).toLowerCase();
    setRecipientValueForField(field, (current) =>
      joinComposeAddressList(
        parseComposeAddressList(current).filter(
          (item) => extractEmailAddress(item).toLowerCase() !== normalized,
        ),
      ),
    );
    setComposeRecipientMenu(null);
  }

  function editComposeRecipient(field: ComposeRecipientField, address: string) {
    removeComposeRecipient(field, address);
    setRecipientDraftForField(field, address);
  }

  function copyComposeRecipient(address: string) {
    void navigator.clipboard?.writeText(address).catch(() => undefined);
    setStatusMessage(`Copied ${address}.`);
    setComposeRecipientMenu(null);
  }

  function openComposeRecipientMenu(
    field: ComposeRecipientField,
    address: string,
    event: ReactMouseEvent,
  ) {
    event.preventDefault();
    setComposeContactPickerField(null);
    setComposeRecipientMenu({
      field,
      address,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function buildContactNote() {
    return [
      contactDraftPhone.trim() ? `Phone: ${contactDraftPhone.trim()}` : null,
      contactDraftAddress.trim() ? `Address: ${contactDraftAddress.trim()}` : null,
      contactDraftBirthday.trim() ? `Birthday: ${contactDraftBirthday.trim()}` : null,
      contactDraftOrganization.trim()
        ? `Organization: ${contactDraftOrganization.trim()}`
        : null,
      contactDraftTitle.trim() ? `Title: ${contactDraftTitle.trim()}` : null,
      contactDraftNote.trim() ? `Notes: ${contactDraftNote.trim()}` : null,
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  function addComposeRecipientFromContact(field: ComposeRecipientField, contact: ContactDto) {
    if (field === "to") {
      setSendTargetAddress((current) => appendComposeRecipientValue(current, contact.email_address));
    } else if (field === "cc") {
      setComposeCcOpen(true);
      setComposeCcAddress((current) => appendComposeRecipientValue(current, contact.email_address));
    } else {
      setComposeBccOpen(true);
      setComposeBccAddress((current) => appendComposeRecipientValue(current, contact.email_address));
    }
    setComposeContactPickerField(null);
    setComposeContactPickerPosition(null);
  }

  function renderComposeRecipientEditor(field: ComposeRecipientField, placeholder: string) {
    const recipients = parseComposeAddressList(recipientValueForField(field));
    const fieldLabel = field.toUpperCase();

    return (
      <div className="nt-compose-recipient-editor" data-recipient-field={field}>
        <div className="nt-compose-recipient-tokens" aria-label={`${fieldLabel} 收件人`}>
          {recipients.map((address) => (
            <span className="nt-compose-recipient-token" key={`${field}:${address}`}>
              <button
                type="button"
                className="nt-compose-recipient-token__menu"
                aria-haspopup="menu"
                aria-expanded={
                  composeRecipientMenu?.field === field && composeRecipientMenu.address === address
                }
                aria-controls="compose-recipient-menu"
                data-nonmodal-trigger="compose-recipient"
                onContextMenu={(event) => openComposeRecipientMenu(field, address, event)}
                onClick={(event) => openComposeRecipientMenu(field, address, event)}
                title="打开收件人操作"
              >
                <span>{address}</span>
              </button>
              <button
                type="button"
                className="nt-compose-recipient-token__remove"
                aria-label={`删除${fieldLabel}收件人 ${address}`}
                onClick={() => removeComposeRecipient(field, address)}
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={composeRecipientDrafts[field]}
            placeholder={recipients.length > 0 ? "" : placeholder}
            aria-label={`${fieldLabel} 收件人输入框`}
            data-compose-initial-focus={field === "to" ? "true" : undefined}
            onChange={(event) => handleComposeRecipientDraftChange(field, event.currentTarget.value)}
            onKeyDown={(event) => handleComposeRecipientDraftKeyDown(field, event)}
            onBlur={() => commitComposeRecipientDraft(field)}
          />
        </div>
        <button
          type="button"
          aria-label={composeContactPickerAriaLabel(field)}
          aria-haspopup="dialog"
          aria-expanded={composeContactPickerField === field}
          aria-controls="compose-contact-picker"
          title="从联系人中选择"
          data-modal-return-focus="contact"
          data-nonmodal-trigger="compose-contact-picker"
          onClick={(event) => toggleComposeContactPicker(field, event)}
        >
          联系人
        </button>
      </div>
    );
  }

  async function createContactFromDraft() {
    const displayName =
      contactDraftDisplayName.trim() ||
      [contactDraftFirstName.trim(), contactDraftLastName.trim()].filter(Boolean).join(" ") ||
      contactDraftEmail.trim();
    setBusy(true);
    try {
      const contact = await contactClient.createContact({
        display_name: displayName,
        email_address: contactDraftEmail,
        note: optionalValue(buildContactNote()),
      });
      const rows = await loadContacts();
      const savedContact =
        rows.find((row) => row.id === contact.id) ??
        rows.find((row) => row.email_address === contact.email_address) ??
        contact;
      if (contactDraftTargetField) {
        addComposeRecipientFromContact(contactDraftTargetField, savedContact);
      }
      setStatusMessage(`已保存联系人 ${savedContact.email_address}。`);
      setError(null);
      closeContactModal();
    } catch (caught: unknown) {
      setError(asErrorDto(caught));
    } finally {
      setBusy(false);
    }
  }

  function renderComposeContactPicker(field: ComposeRecipientField) {
    if (composeContactPickerField !== field) {
      return null;
    }

    return (
      <section
        id="compose-contact-picker"
        className={`nt-compose-contact-picker nt-compose-contact-picker--${field}`}
        style={composeContactPickerPosition ?? undefined}
        role="dialog"
        aria-label="联系人"
        data-nonmodal-layer="compose-contact-picker"
      >
        <header>
          <strong>联系人</strong>
          <span>{field.toUpperCase()}</span>
          <button type="button" onClick={() => openContactModal(field)}>
            新建
          </button>
        </header>
        <div className="nt-compose-contact-list">
          {contacts.length > 0 ? (
            contacts.map((contact) => (
              <button
                type="button"
                className="nt-compose-contact-option"
                key={`${field}:${contact.id}`}
                onClick={() => addComposeRecipientFromContact(field, contact)}
              >
                <span className="nt-compose-contact-avatar" aria-hidden="true">
                  {contact.display_name.slice(0, 2).toUpperCase()}
                </span>
                <span className="nt-compose-contact-main">
                  <strong>{contact.display_name}</strong>
                  <small>{contact.email_address}</small>
                </span>
                {contact.note ? <em>{contact.note}</em> : null}
              </button>
            ))
          ) : (
            <button
              type="button"
              className="nt-compose-contact-empty"
              onClick={() => openContactModal(field)}
            >
              新建联系人
            </button>
          )}
        </div>
      </section>
    );
  }

  async function queueComposePopoverSend() {
    const sent = await enqueueDraftSend();
    if (sent) {
      closeComposeFormattingPopovers();
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

  return (
    <main
      className={`nt-app-shell nt-app-shell--edge-rail ${
        activeView === "mail" ? "nt-app-shell--mail-compact" : ""
      } ${
        railCollapsed ? "nt-app-shell--rail-collapsed" : "nt-app-shell--rail-expanded"
      }`}
      data-view={activeView}
      aria-busy={busy}
    >
      {busy ? (
        <div className="nt-global-busy" role="status" aria-live="polite" aria-atomic="true">
          <span className="nt-global-busy__bar" aria-hidden="true" />
          {initializing ? (
            <span className="nt-global-busy__message">{statusMessage}</span>
          ) : (
            <span className="nt-visually-hidden">正在处理</span>
          )}
        </div>
      ) : null}
      <input
        ref={avatarFileInputRef}
        className="nt-hidden-file-input"
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/x-icon"
        onChange={handleContactAvatarFile}
      />
      <input
        ref={platformAvatarFileInputRef}
        className="nt-hidden-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
        onChange={handlePlatformAvatarFile}
      />
      {avatarEditor ? (
        <div
          className="nt-avatar-popover"
          role="dialog"
          aria-label="发件人图标编辑器"
          data-nonmodal-layer="avatar-editor"
          style={{ left: avatarEditor.left, top: avatarEditor.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="nt-avatar-popover__head">
            <SenderAvatarIcon value={avatarEditor.sender} avatar={avatarEditorAvatar} />
            <div>
              <strong>{displayNameFromAddress(avatarEditor.sender)}</strong>
              <span>{extractEmailAddress(avatarEditor.sender)}</span>
            </div>
          </div>
          <div className="nt-avatar-popover__actions">
            <button type="button" onClick={chooseAvatarEditorFile} disabled={busy}>
              Upload custom icon
            </button>
            <button
              type="button"
              onClick={() => void clearAvatarEditorContact()}
              disabled={busy || !avatarEditorHasCustomIcon}
            >
              Clear custom icon
            </button>
          </div>
          <button
            type="button"
            className="nt-avatar-popover__close"
            onClick={() => setAvatarEditor(null)}
          >
            Close
          </button>
        </div>
      ) : null}
      {platformAccountMenuOpen && !railCollapsed ? (
        <>
          <button
            type="button"
            className="nt-platform-account-popover-backdrop"
            aria-label="关闭平台账户菜单"
            onClick={() => setPlatformAccountMenuOpen(false)}
          />
          <section
            className={`nt-platform-account-popover ${
              platformAccountSignedIn ? "nt-platform-account-popover--signed-in" : "nt-platform-account-popover--signed-out"
            }`}
            role="dialog"
            aria-label="平台账户菜单"
            data-nonmodal-layer="platform-account"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="nt-platform-account-popover__hero">
              <span className="nt-platform-account-popover__avatar" aria-hidden="true">
                {platformAccountSignedIn && platformAccountAvatarDataUrl ? (
                  <img src={platformAccountAvatarDataUrl} alt="" />
                ) : platformAccountSignedIn ? (
                  platformAccountInitial
                ) : (
                  "N"
                )}
              </span>
              <strong>{platformAccountPopoverTitle}</strong>
              <span>{platformAccountPopoverEmail}</span>
            </div>

            <div className="nt-platform-account-popover__actions">
              {platformAccountSignedIn ? (
                <button
                  type="button"
                  className="nt-platform-account-popover__danger"
                  onClick={signOutPlatformAccount}
                  disabled={busy}
                >
                  退出预览账户
                </button>
              ) : (
                <button
                  type="button"
                  className="nt-platform-account-popover__primary"
                  onClick={() => void signInPlatformAccount()}
                  disabled={busy}
                >
                  使用开发预览账户登录
                </button>
              )}
            </div>
          </section>
        </>
      ) : null}
      {railModePickerOpen && railCollapsed ? (
        <>
          <button
            type="button"
            className="nt-mode-popover-backdrop"
            aria-label="关闭模式选择器"
            onClick={() => setRailModePickerOpen(false)}
          />
          <section
            className="nt-mode-popover"
            role="menu"
            aria-label="邮件模式选择器"
            data-nonmodal-layer="rail-mode"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitemradio"
              data-mode="mail"
              aria-label="切换到邮件模式"
              aria-checked={railMode === "mail"}
              title="邮件"
              className={`nt-mode-popover__item ${
                railMode === "mail" ? "nt-mode-popover__item--active" : ""
              }`}
              onClick={() => selectRailMode("mail")}
            >
              <span className="nt-mode-popover__icon">
                <RailIcon kind="mail" />
              </span>
            </button>
            <button
              type="button"
              role="menuitemradio"
              data-mode="agent"
              aria-label="切换到代理模式"
              aria-checked={railMode === "agent"}
              title="代理"
              className={`nt-mode-popover__item ${
                railMode === "agent" ? "nt-mode-popover__item--active" : ""
              }`}
              onClick={() => selectRailMode("agent")}
            >
              <span className="nt-mode-popover__icon">
                <RailIcon kind="agent" />
              </span>
            </button>
          </section>
        </>
      ) : null}
      {composePopoverOpen ? (
        <>
          <div className="nt-compose-popover-backdrop" aria-hidden="true" />
          <section
            className={`nt-compose-popover ${
              composePopoverMinimized ? "nt-compose-popover--minimized" : ""
            } ${composePopoverExpanded ? "nt-compose-popover--expanded" : ""}`}
            role="dialog"
            id="compose-popover"
            aria-label="写邮件"
            aria-modal="false"
            data-nonmodal-layer="compose-popover"
            data-nonmodal-preserve-focus
          >
            <header className="nt-compose-popover__titlebar">
              <button
                type="button"
                className="nt-compose-popover__grabber"
                aria-label={composePopoverMinimized ? "恢复写信窗口" : "写信窗口"}
                onClick={() => setComposePopoverMinimized(false)}
              >
                <span aria-hidden="true">⋮⋮</span>
              </button>
              <strong>{sendSubject.trim() || "写邮件"}</strong>
              <div className="nt-compose-popover__window-controls">
                <button
                  type="button"
                  aria-label="最小化写信窗口"
                  onClick={() => setComposePopoverMinimized(true)}
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label={composePopoverExpanded ? "恢复写信窗口大小" : "展开写信窗口"}
                  aria-expanded={composePopoverExpanded}
                  onClick={() => {
                    setComposePopoverMinimized(false);
                    setComposePopoverExpanded((value) => !value);
                  }}
                >
                  ↗
                </button>
                <button
                  type="button"
                  aria-label="关闭写信窗口"
                  onClick={closeComposePopover}
                >
                  ×
                </button>
              </div>
            </header>

            {!composePopoverMinimized ? (
              <>
                <div className="nt-compose-popover__fields">
                  <label className="nt-compose-popover__row">
                    <span>发件人</span>
                    <select
                      value={selectedNormalAccountId ?? ""}
                      onChange={(event) => setSelectedNormalAccountId(event.currentTarget.value || null)}
                    >
                      <option value="">选择可发送账户</option>
                      {sendEnabledAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.display_name} - {account.primary_address ?? account.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="nt-compose-popover__row">
                    <span>收件人</span>
                    {renderComposeRecipientEditor("to", "target@example.com")}
                    <button
                      type="button"
                      aria-expanded={composeCcOpen}
                      aria-controls="compose-cc-recipients"
                      onClick={() => setComposeCcOpen((value) => !value)}
                    >
                      CC
                    </button>
                    <button
                      type="button"
                      aria-expanded={composeBccOpen}
                      aria-controls="compose-bcc-recipients"
                      onClick={() => setComposeBccOpen((value) => !value)}
                    >
                      BCC
                    </button>
                  </div>
                  {renderComposeContactPicker("to")}
                  {composeCcOpen ? (
                    <div id="compose-cc-recipients" className="nt-compose-popover__row">
                      <span>CC</span>
                      {renderComposeRecipientEditor("cc", "cc@example.com")}
                    </div>
                  ) : null}
                  {composeCcOpen ? renderComposeContactPicker("cc") : null}
                  {composeBccOpen ? (
                    <div id="compose-bcc-recipients" className="nt-compose-popover__row">
                      <span>BCC</span>
                      {renderComposeRecipientEditor("bcc", "bcc@example.com")}
                    </div>
                  ) : null}
                  {composeBccOpen ? renderComposeContactPicker("bcc") : null}
                  <label className="nt-compose-popover__row">
                    <span>主题</span>
                    <input
                      value={sendSubject}
                      placeholder="主题"
                      onChange={(event) => setSendSubject(event.currentTarget.value)}
                    />
                  </label>
                </div>

                <div
                  className={`nt-compose-popover__body ${
                    composeAiAssistVisible ? "" : "nt-compose-popover__body--no-ai"
                  }`}
                >
                  {composeAiAssistVisible ? (
                    <div
                      className="nt-compose-popover__toolbar nt-compose-popover__toolbar--ai"
                      aria-label="AI 写作辅助工具栏（模板预览）"
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <span className="nt-compose-toolbar-note">模板预览</span>
                      <button type="button" onClick={() => applyComposeRichCommand("ai")}>
                        ✨ 为我撰写
                      </button>
                      <button type="button" onClick={() => applyComposeRichCommand("review")}>
                        ⟳ 审阅
                      </button>
                      <button type="button" onClick={() => applyComposeAiExpandSelection()}>
                        ↔ 展开
                      </button>
                      <button type="button" onClick={() => insertComposeRichText("请将上文缩短为更简洁的版本。")}>
                        ↔ 缩短
                      </button>
                      <span className="nt-compose-ai-more-control">
                        <button
                          type="button"
                          aria-label="更多 AI 写作操作"
                          aria-haspopup="menu"
                          aria-expanded={composeAiMoreMenuOpen}
                          aria-controls="compose-ai-more-menu"
                          data-nonmodal-trigger="compose-ai-more"
                          onClick={() => {
                            setComposeAiMoreMenuOpen((value) => !value);
                            setComposeMoreMenuOpen(false);
                          }}
                        >
                          ⋯
                        </button>
                        {renderComposeAiMoreMenu()}
                      </span>
                    </div>
                  ) : null}
                  <div
                    ref={composeBodyEditorRef}
                    className="nt-compose-rich-editor"
                    aria-label="邮件正文"
                    role="textbox"
                    aria-multiline="true"
                    contentEditable
                    suppressContentEditableWarning
                    data-placeholder="在当前阅读上下文中撰写邮件"
                    style={{
                      fontFamily: composeFontCss(composeFontFamily),
                      fontSize: composeFontSize,
                      color: composeTextColor,
                      backgroundColor: composeBackgroundColor,
                    }}
                    onInput={handleComposeRichInput}
                    onPaste={handleComposeRichPaste}
                    onFocus={() => saveComposeEditorSelection()}
                    onKeyUp={() => saveComposeEditorSelection()}
                    onMouseUp={() => saveComposeEditorSelection()}
                    onBlur={syncComposeRichBodyState}
                  />
                </div>

                {composeFormatbarOpen ? (
                  <div
                    className="nt-compose-popover__formatbar"
                    onMouseDown={(event) => {
                      const target = event.target as Element;
                      if (target.closest(".nt-compose-emoji-popover")) {
                        return;
                      }
                      preserveComposeEditorSelection(event);
                    }}
                  >
                    <div className="nt-compose-format-control">
                      <button
                        type="button"
                        className="nt-compose-format-select"
                        aria-haspopup="listbox"
                        aria-expanded={composeFontMenuOpen}
                        aria-controls="compose-font-menu"
                        data-nonmodal-trigger="compose-font"
                        onClick={() => {
                          setComposeFontMenuOpen((value) => !value);
                          setComposeFontSizeMenuOpen(false);
                          setComposeColorMenuOpen(false);
                          setComposeMoreMenuOpen(false);
                        }}
                      >
                        {composeFontFamily}
                      </button>
                      {composeFontMenuOpen ? (
                        <div
                          id="compose-font-menu"
                          className="nt-compose-format-menu nt-compose-format-menu--font"
                          role="listbox"
                          aria-label="字体"
                          data-nonmodal-layer="compose-font"
                        >
                          {COMPOSE_FONT_OPTIONS.map((font) => (
                            <button
                              type="button"
                              role="option"
                              aria-selected={composeFontFamily === font.label}
                              key={font.label}
                              style={{ fontFamily: font.css }}
                              className={
                                composeFontFamily === font.label
                                  ? "nt-compose-format-menu__item nt-compose-format-menu__item--active"
                                  : "nt-compose-format-menu__item"
                              }
                              onClick={() => chooseComposeFont(font.label)}
                            >
                              <span>{font.label}</span>
                              {composeFontFamily === font.label ? <em>默认</em> : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="nt-compose-format-control">
                      <button
                        type="button"
                        className="nt-compose-format-select nt-compose-format-select--size"
                        aria-haspopup="listbox"
                        aria-expanded={composeFontSizeMenuOpen}
                        aria-controls="compose-font-size-menu"
                        data-nonmodal-trigger="compose-font-size"
                        onClick={() => {
                          setComposeFontSizeMenuOpen((value) => !value);
                          setComposeFontMenuOpen(false);
                          setComposeColorMenuOpen(false);
                          setComposeMoreMenuOpen(false);
                        }}
                      >
                        {composeFontSize}
                      </button>
                      {composeFontSizeMenuOpen ? (
                        <div
                          id="compose-font-size-menu"
                          className="nt-compose-format-menu nt-compose-format-menu--size"
                          role="listbox"
                          aria-label="字号"
                          data-nonmodal-layer="compose-font-size"
                        >
                          {COMPOSE_FONT_SIZE_OPTIONS.map((size) => (
                            <button
                              type="button"
                              role="option"
                              aria-selected={composeFontSize === size}
                              key={size}
                              className={
                                composeFontSize === size
                                  ? "nt-compose-format-menu__item nt-compose-format-menu__item--active"
                                  : "nt-compose-format-menu__item"
                              }
                              onClick={() => chooseComposeFontSize(size)}
                            >
                              <span>{size}</span>
                              {composeFontSize === size ? <em>默认</em> : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="nt-compose-format-control">
                      <button
                        type="button"
                        className="nt-compose-color-button"
                        aria-label="文本与背景颜色"
                        aria-haspopup="dialog"
                        aria-expanded={composeColorMenuOpen}
                        aria-controls="compose-color-popover"
                        data-nonmodal-trigger="compose-color"
                        onClick={() => {
                          setComposeColorMenuOpen((value) => !value);
                          setComposeFontMenuOpen(false);
                          setComposeFontSizeMenuOpen(false);
                          setComposeMoreMenuOpen(false);
                        }}
                      >
                        <span style={{ background: composeTextColor }} />
                      </button>
                      {composeColorMenuOpen ? (
                        <div
                          id="compose-color-popover"
                          className="nt-compose-color-popover"
                          role="dialog"
                          aria-label="文本与背景颜色"
                          data-nonmodal-layer="compose-color"
                        >
                          <div className="nt-compose-color-tabs">
                            <button
                              type="button"
                              className={composeColorMode === "text" ? "is-active" : ""}
                              onClick={() => setComposeColorMode("text")}
                            >
                            文本颜色
                            </button>
                            <button
                              type="button"
                              className={composeColorMode === "background" ? "is-active" : ""}
                              onClick={() => setComposeColorMode("background")}
                            >
                            背景颜色
                            </button>
                          </div>
                          <div className="nt-compose-color-grid">
                            {COMPOSE_COLOR_SWATCHES.map((color) => {
                              const active =
                                composeColorMode === "text"
                                  ? composeTextColor === color
                                  : composeBackgroundColor === color;
                              return (
                                <button
                                  type="button"
                                  key={`${composeColorMode}:${color}`}
                                  className={
                                    active
                                      ? "nt-compose-color-swatch nt-compose-color-swatch--active"
                                      : "nt-compose-color-swatch"
                                  }
                                  style={{ background: color }}
                                  aria-label={`${composeColorMode} ${color}`}
                                  onClick={() => chooseComposeColor(color)}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className={composeFormatButtonClass("bold")}
                      aria-label="粗体"
                      aria-pressed={composeActiveFormats.bold}
                      onClick={() => applyComposeRichCommand("bold")}
                    >
                      B
                    </button>
                    <button
                      type="button"
                      className={composeFormatButtonClass("italic")}
                      aria-label="斜体"
                      aria-pressed={composeActiveFormats.italic}
                      onClick={() => applyComposeRichCommand("italic")}
                    >
                      I
                    </button>
                    <button
                      type="button"
                      className={composeFormatButtonClass("underline")}
                      aria-label="下划线"
                      aria-pressed={composeActiveFormats.underline}
                      onClick={() => applyComposeRichCommand("underline")}
                    >
                      U
                    </button>
                    <button
                      type="button"
                      className={composeFormatButtonClass("strike")}
                      aria-label="删除线"
                      aria-pressed={composeActiveFormats.strike}
                      onClick={() => applyComposeRichCommand("strike")}
                    >
                      S
                    </button>
                    <button
                      type="button"
                      className={composeFormatButtonClass("unorderedList")}
                      aria-label="无序列表"
                      aria-pressed={composeActiveFormats.unorderedList}
                      title="无序列表"
                      onClick={() => applyComposeRichCommand("unordered-list")}
                    >
                      •≡
                    </button>
                    <button
                      type="button"
                      className={composeFormatButtonClass("orderedList")}
                      aria-label="有序列表"
                      aria-pressed={composeActiveFormats.orderedList}
                      title="有序列表"
                      onClick={() => applyComposeRichCommand("ordered-list")}
                    >
                      1≡
                    </button>
                    <div className="nt-compose-format-control">
                      <button
                        type="button"
                        className="nt-compose-format-button"
                        aria-label="对齐方式"
                        aria-haspopup="menu"
                        aria-expanded={composeAlignmentMenuOpen}
                        aria-controls="compose-alignment-menu"
                        title="对齐方式"
                        data-nonmodal-trigger="compose-alignment"
                        onClick={() => {
                          setComposeAlignmentMenuOpen((value) => !value);
                          setComposeFontMenuOpen(false);
                          setComposeFontSizeMenuOpen(false);
                          setComposeColorMenuOpen(false);
                          setComposeEmojiPickerOpen(false);
                          setComposeMoreMenuOpen(false);
                        }}
                      >
                        ≔
                      </button>
                      {composeAlignmentMenuOpen ? (
                        <div
                          id="compose-alignment-menu"
                          className="nt-compose-alignment-menu"
                          role="menu"
                          aria-label="对齐方式"
                          data-nonmodal-layer="compose-alignment"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onMouseDown={preserveComposeEditorSelection}
                            onClick={() => {
                              applyComposeRichCommand("align-left");
                            }}
                          >
                            左对齐
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onMouseDown={preserveComposeEditorSelection}
                            onClick={() => applyComposeRichCommand("align-center")}
                          >
                            居中对齐
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onMouseDown={preserveComposeEditorSelection}
                            onClick={() => applyComposeRichCommand("align-right")}
                          >
                            右对齐
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="nt-compose-format-button"
                      aria-label="选择表情"
                      aria-haspopup="dialog"
                      aria-expanded={composeEmojiPickerOpen}
                      aria-controls="compose-emoji-popover"
                      data-nonmodal-trigger="compose-emoji"
                      onClick={() => applyComposeRichCommand("emoji")}
                    >
                      ☺
                    </button>
                    {composeEmojiPickerOpen ? (
                      <div
                        id="compose-emoji-popover"
                        className="nt-compose-emoji-popover"
                        role="dialog"
                        aria-label="表情选择器"
                        data-nonmodal-layer="compose-emoji"
                      >
                        <div className="nt-compose-emoji-tabs" role="tablist" aria-label="表情分类">
                          {COMPOSE_EMOJI_CATEGORIES.map((category) => (
                            <button
                              type="button"
                              key={category.id}
                              className={`nt-compose-emoji-tab ${
                                composeEmojiActiveCategoryId === category.id
                                  ? "nt-compose-emoji-tab--active"
                                  : ""
                              }`}
                              role="tab"
                              aria-selected={composeEmojiActiveCategoryId === category.id}
                              aria-label={category.label}
                              onMouseDown={preserveComposeEditorSelection}
                              onClick={() => setComposeEmojiActiveCategoryId(category.id)}
                            >
                              {category.icon}
                            </button>
                          ))}
                        </div>
                        <label className="nt-compose-emoji-search">
                          <span aria-hidden="true">⌕</span>
                          <input
                            value={composeEmojiSearch}
                            onChange={(event) => setComposeEmojiSearch(event.currentTarget.value)}
                            placeholder="搜索表情"
                            aria-label="搜索表情"
                          />
                          {composeEmojiSearch ? (
                            <button
                              type="button"
                            aria-label="清除表情搜索"
                              onMouseDown={preserveComposeEditorSelection}
                              onClick={() => setComposeEmojiSearch("")}
                            >
                              ×
                            </button>
                          ) : null}
                        </label>
                        <div className="nt-compose-emoji-scroll">
                          {filteredComposeEmojiCategories.length > 0 ? (
                            filteredComposeEmojiCategories.map((category) => (
                            <section key={category.id}>
                              <h4>{category.label}</h4>
                              <div className="nt-compose-emoji-grid">
                                {category.emojis.map((emoji) => (
                                  <button
                                    type="button"
                                    className="nt-compose-emoji-button"
                                    key={`${category.id}-${emoji.symbol}`}
                                aria-label={`插入 ${emoji.symbol}`}
                                    onMouseDown={preserveComposeEditorSelection}
                                    onClick={() => insertComposeEmoji(emoji.symbol)}
                                  >
                                    {emoji.symbol}
                                  </button>
                                ))}
                              </div>
                            </section>
                            ))
                          ) : (
                            <p
                              className="nt-compose-emoji-empty"
                              role="status"
                              aria-live="polite"
                              data-empty-state
                            >
                              未找到匹配表情
                            </p>
                          )}
                        </div>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className={composeFormatButtonClass("quote")}
                      aria-label="引用"
                      aria-pressed={composeActiveFormats.quote}
                      title="引用"
                      onClick={() => applyComposeRichCommand("quote")}
                    >
                      ″
                    </button>
                    <button
                      type="button"
                      className="nt-compose-format-button"
                      aria-label="插入链接"
                      title="插入链接"
                      onClick={() => applyComposeRichCommand("link")}
                    >
                      🔗
                    </button>
                    <button
                      type="button"
                      className="nt-compose-format-button"
                      aria-label="清除格式"
                      title="清除格式"
                      onClick={() => applyComposeRichCommand("remove-format")}
                    >
                      <ClearFormatIcon />
                    </button>
                    <div className="nt-compose-format-more-control">
                      <button
                        type="button"
                        aria-label="更多格式操作"
                        aria-haspopup="menu"
                        aria-expanded={
                          composeMoreMenuOpen && composeMoreMenuAnchor === "formatbar"
                        }
                        aria-controls="compose-more-menu"
                        data-nonmodal-trigger="compose-more"
                        onClick={() => {
                          setComposeMoreMenuAnchor("formatbar");
                          setComposeMoreMenuOpen((value) =>
                            composeMoreMenuAnchor === "formatbar" ? !value : true,
                          );
                        }}
                      >
                        ⋯
                      </button>
                      {renderComposeMoreMenu("formatbar")}
                    </div>
                  </div>
                ) : null}

                {composeAttachments.length > 0 ? (
                  <div className="nt-compose-attachments" aria-label="待发送附件">
                    {composeAttachments.map((attachment) => (
                      <span key={attachment.id}>
                        📎 {attachment.name}
                        <em>{Math.ceil(attachment.size / 1024)} KB</em>
                      </span>
                    ))}
                  </div>
                ) : null}

                <footer className="nt-compose-popover__actions">
                  <div className="nt-compose-popover__utility-actions">
                    <button
                      type="button"
                      aria-label="删除草稿"
                      title="删除草稿"
                      onClick={discardComposeDraft}
                    >
                      🗑
                    </button>
                    <div className="nt-compose-action-control">
                      <button
                        type="button"
                        aria-label="邮件加密"
                        title="邮件加密"
                        aria-haspopup="dialog"
                        aria-expanded={composeEncryptionModalOpen || composeEncryptionMenuOpen}
                        aria-controls={
                          composeEncryptionModalOpen ? "compose-encryption-modal" : undefined
                        }
                        onClick={openComposeEncryptionModal}
                      >
                        {composeExternalEncryption ? "🔐" : "🔒"}
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label="上传附件"
                      title="上传附件"
                      onClick={() => composeAttachmentInputRef.current?.click()}
                    >
                      📎
                    </button>
                    <button
                      type="button"
                      aria-label={composeAiAssistVisible ? "收起 AI 辅助" : "展开 AI 辅助"}
                      title={composeAiAssistVisible ? "收起 AI 辅助" : "展开 AI 辅助"}
                      aria-pressed={composeAiAssistVisible}
                      onClick={() => setComposeAiAssistVisible((value) => !value)}
                    >
                      ✦
                    </button>
                    <button
                      type="button"
                      aria-label={composeFormatbarOpen ? "收起格式工具栏" : "展开格式工具栏"}
                      title={composeFormatbarOpen ? "收起格式工具栏" : "展开格式工具栏"}
                      aria-pressed={composeFormatbarOpen}
                      onClick={() => setComposeFormatbarOpen((value) => !value)}
                    >
                      A
                    </button>
                    <div className="nt-compose-action-control">
                      <button
                        type="button"
                        aria-label="更多写信选项"
                        title="更多内容"
                        aria-haspopup="menu"
                        aria-expanded={composeBottomMoreOpen}
                        aria-controls="compose-bottom-more-menu"
                        data-nonmodal-trigger="compose-bottom-more"
                        onClick={() => {
                          setComposeBottomMoreOpen((value) => !value);
                          setComposeEncryptionMenuOpen(false);
                          setComposeScheduleSendOpen(false);
                        }}
                      >
                        ⋯
                      </button>
                      {composeBottomMoreOpen ? (
                        <div
                          id="compose-bottom-more-menu"
                          className="nt-compose-popover__bottom-menu"
                          role="menu"
                          aria-label="更多写信选项"
                          data-nonmodal-layer="compose-bottom-more"
                        >
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={!composePlainTextMode}
                            onClick={() => setComposePlainTextMode(false)}
                          >
                            {!composePlainTextMode ? "✓ " : ""}普通
                          </button>
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={composePlainTextMode}
                            onClick={() => setComposePlainTextMode(true)}
                          >
                            {composePlainTextMode ? "✓ " : ""}纯文本
                          </button>
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={composeAttachPublicKey}
                            onClick={() => setComposeAttachPublicKey((value) => !value)}
                          >
                            {composeAttachPublicKey ? "✓ " : ""}附上公钥
                          </button>
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={composeRequestReadReceipt}
                            onClick={() => setComposeRequestReadReceipt((value) => !value)}
                          >
                            {composeRequestReadReceipt ? "✓ " : ""}请对方发送回执
                          </button>
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={composeExpirationEnabled}
                            onClick={() => {
                              rememberModalReturnFocus();
                              setComposeBottomMoreOpen(false);
                              setComposeExpirationModalOpen(true);
                            }}
                          >
                            {composeExpirationEnabled ? "✓ " : ""}邮件有效期
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <span className="nt-compose-popover__saved-state">
                    {composeDraftDirty ? "保存中…" : formatComposeDraftSavedAt(composeDraftSavedAt)}
                  </span>
                  <div className="nt-compose-send-control">
                    {composeScheduledAtIso ? (
                      <span className="nt-compose-send-control__schedule-summary">
                        准备 {formatComposeScheduleDate(new Date(composeScheduledAtIso))}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="nt-compose-popover__send"
                      onClick={() => void queueComposePopoverSend()}
                      disabled={busy}
                    >
                      {composeScheduledAtIso ? "定时发送" : "发送"}
                    </button>
                    <button
                      type="button"
                      className="nt-compose-popover__send-menu"
                      aria-label="打开定时发送选项"
                      aria-haspopup="dialog"
                      aria-expanded={composeScheduleSendOpen}
                      aria-controls="compose-schedule-popover"
                      data-nonmodal-trigger="compose-schedule"
                      onClick={() => {
                        setComposeScheduleSendOpen((value) => !value);
                        setComposeBottomMoreOpen(false);
                        setComposeEncryptionMenuOpen(false);
                        setComposeMoreMenuOpen(false);
                        setComposeEmojiPickerOpen(false);
                        setComposeAlignmentMenuOpen(false);
                        setComposeFontMenuOpen(false);
                        setComposeFontSizeMenuOpen(false);
                        setComposeColorMenuOpen(false);
                      }}
                    >
                      ⌄
                    </button>
                    {composeScheduleSendOpen ? (
                      <div
                        id="compose-schedule-popover"
                        className="nt-compose-schedule-popover"
                        role="dialog"
                        aria-label="定时发送"
                        data-nonmodal-layer="compose-schedule"
                      >
                        <header>
                          <strong>定时发送</strong>
                          <span>您想何时发送邮件?</span>
                        </header>
                        <button type="button" onClick={clearComposeSchedule}>
                          <span>{composeScheduledAtIso ? "" : "✓ "}直接发送</span>
                          <em>取消定时</em>
                        </button>
                        <div className="nt-compose-schedule-custom" role="group" aria-label="其他发送时间">
                          <span className="nt-compose-schedule-custom__label">
                            {composeSchedulePreset === "custom" ? "✓ " : ""}其他
                          </span>
                          <input
                            aria-label="选择其他发送时间"
                            type="datetime-local"
                            step={60}
                            value={composeScheduleCustomValue}
                            onChange={(event) => applyComposeCustomScheduleValue(event.currentTarget.value)}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </footer>
              </>
            ) : null}
            {composeEncryptionModalOpen ? (
              <>
                <div className="nt-compose-encryption-modal-backdrop" aria-hidden="true" />
                <form
                  id="compose-encryption-modal"
                  className="nt-compose-encryption-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="邮件加密"
                  data-modal-id="compose-encryption"
                  tabIndex={-1}
                  onSubmit={submitComposeEncryptionModal}
                >
                  <header>
                    <strong>邮件加密</strong>
                    <span className="nt-compose-modal-note">预览能力</span>
                  </header>
                  <p>
                    为这封邮件设置访问密码。对方需要输入密码才能查看受保护内容。
                    <br />
                    这是本地预览设置，当前不会对外发送真正加密的邮件内容。
                  </p>
                  <div className="nt-compose-encryption-field">
                    <label htmlFor="compose-encryption-password">
                      密码 <em>ⓘ</em>
                    </label>
                    <div className="nt-compose-encryption-password-row">
                      <input
                        id="compose-encryption-password"
                        aria-label="密码"
                        type={composeEncryptionPasswordVisible ? "text" : "password"}
                        data-modal-initial-focus
                        value={composeEncryptionPassword}
                        placeholder="密码"
                        minLength={8}
                        onChange={(event) => setComposeEncryptionPassword(event.currentTarget.value)}
                        required
                      />
                      <button
                        type="button"
                        aria-label="显示或隐藏加密密码"
                        onClick={() => setComposeEncryptionPasswordVisible((value) => !value)}
                      >
                        {composeEncryptionPasswordVisible ? "🙈" : "👁"}
                      </button>
                      <button
                        type="button"
                        aria-label="复制加密密码"
                        onClick={copyComposeEncryptionPassword}
                      >
                        ⧉
                      </button>
                    </div>
                  </div>
                  <label>
                    <span>密码提示 <em>可选的</em></span>
                    <input
                      value={composeEncryptionHint}
                      placeholder="提示"
                      onChange={(event) => setComposeEncryptionHint(event.currentTarget.value)}
                    />
                  </label>
                  <footer>
                    <button type="submit">设置加密</button>
                    <button type="button" onClick={() => setComposeEncryptionModalOpen(false)}>
                      取消
                    </button>
                  </footer>
                </form>
              </>
            ) : null}
          </section>
        </>
      ) : null}
      {composeExpirationModalOpen ? (
        <>
          <div className="nt-compose-expiration-modal-backdrop" aria-hidden="true" />
          <form
            className="nt-compose-expiration-modal"
            role="dialog"
            aria-modal="true"
            aria-label="邮件有效期"
            data-modal-id="compose-expiration"
            tabIndex={-1}
            onSubmit={submitComposeExpirationModal}
          >
            <header>
              <strong>邮件有效期</strong>
              <span className="nt-compose-modal-note">本地标记</span>
            </header>
            <p>
              您想何时将此邮件从对方的收件箱和您的已发送列表中删除?
              <br />
              当前这只会保存为本地预览标记，不会真正删除对方收件箱中的邮件。
            </p>
            <div className="nt-compose-modal-grid">
              <label>
                <span>日期</span>
                <input
                  type="date"
                  data-modal-initial-focus
                  value={composeExpirationDate}
                  onChange={(event) => setComposeExpirationDate(event.currentTarget.value)}
                  required
                />
              </label>
              <label>
                <span>时间</span>
                <input
                  type="time"
                  value={composeExpirationTime}
                  onChange={(event) => setComposeExpirationTime(event.currentTarget.value)}
                  required
                />
              </label>
            </div>
            <label className="nt-compose-modal-check">
              <input
                type="checkbox"
                checked={composeExpirationSendOutside}
                onChange={() => setComposeExpirationSendOutside((value) => !value)}
              />
              <span>我需要将此邮件发给外部邮箱。</span>
            </label>
            <footer>
              <button type="submit">设置</button>
              <button type="button" onClick={() => setComposeExpirationModalOpen(false)}>
                取消
              </button>
            </footer>
          </form>
        </>
      ) : null}
      <input
        ref={composeImageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={handleComposeImageFile}
      />
      <input
        ref={composeAttachmentInputRef}
        type="file"
        multiple
        hidden
        onChange={handleComposeAttachmentFiles}
      />
      {composeLinkModalOpen ? (
        <>
          <div className="nt-compose-link-modal-backdrop" aria-hidden="true" />
          <form
            className="nt-compose-link-modal"
            role="dialog"
            aria-modal="true"
            aria-label="插入链接"
            data-modal-id="compose-link"
            tabIndex={-1}
            onSubmit={submitComposeLinkModal}
          >
            <header>
              <strong>插入链接</strong>
              <button type="button" onClick={() => setComposeLinkModalOpen(false)} aria-label="关闭">
                ×
              </button>
            </header>
            <p>请选择链接类型并填写相关信息。</p>
            <label>
              <span>链接类型</span>
              <select
                value={composeLinkType}
                onChange={(event) => setComposeLinkType(event.currentTarget.value as ComposeLinkType)}
              >
                <option value="web">网址</option>
                <option value="email">电子邮件地址</option>
                <option value="phone">电话号码</option>
              </select>
            </label>
            <label>
              <span>
                {composeLinkType === "web"
                  ? "网址"
                  : composeLinkType === "email"
                    ? "电子邮件地址"
                    : "电话号码"}
              </span>
              <input
                value={composeLinkUrl}
                onChange={(event) => setComposeLinkUrl(event.currentTarget.value)}
                placeholder={
                  composeLinkType === "web"
                    ? "链接"
                    : composeLinkType === "email"
                      ? "name@example.com"
                      : "+86 138 0000 0000"
                }
                data-modal-initial-focus
                required
              />
            </label>
            <label>
              <span>要显示的文字</span>
              <input
                value={composeLinkText}
                onChange={(event) => setComposeLinkText(event.currentTarget.value)}
                placeholder="文本"
                required
              />
            </label>
            <div className="nt-compose-link-modal__test">
              <span>测试链接</span>
              {normalizedComposeLinkHref && composeLinkText.trim() ? (
                <a
                  href={normalizedComposeLinkHref}
                  target="_blank"
                  rel="noreferrer"
                >
                  {composeLinkText}
                </a>
              ) : composeLinkUrl.trim() && composeLinkText.trim() ? (
                <em role="alert">链接格式无效</em>
              ) : (
                <em>请先输入链接内容</em>
              )}
            </div>
            <footer>
              <button type="button" onClick={() => setComposeLinkModalOpen(false)}>
                取消
              </button>
              <button
                type="submit"
                disabled={!normalizedComposeLinkHref || !composeLinkText.trim()}
              >
                插入
              </button>
            </footer>
          </form>
        </>
      ) : null}
      {mailTaxonomyManagerKind ? (
        <>
          <div className="nt-mail-taxonomy-modal-backdrop" aria-hidden="true" />
          <form
            className="nt-mail-taxonomy-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${mailTaxonomyKindLabel(mailTaxonomyManagerKind)}管理`}
            data-modal-id="mail-taxonomy"
            tabIndex={-1}
            onSubmit={submitMailTaxonomyManager}
          >
            <header className="nt-mail-taxonomy-modal__header">
              <div>
                <p className="nt-kicker">MAIL ORGANIZATION</p>
                <strong>{mailTaxonomyKindLabel(mailTaxonomyManagerKind)}管理</strong>
              </div>
              <button type="button" aria-label="关闭" onClick={closeMailTaxonomyManager}>
                ×
              </button>
            </header>
            <div className="nt-mail-taxonomy-modal__body">
              <section className="nt-mail-taxonomy-modal__editor">
                <label>
                  <span>{mailTaxonomyKindLabel(mailTaxonomyManagerKind)}名称</span>
                  <input
                    data-modal-initial-focus
                    value={mailTaxonomyDraftName}
                    maxLength={64}
                    placeholder={
                      mailTaxonomyManagerKind === "folder" ? "例如：账单、客户、项目" : "例如：重要、待处理、客户"
                    }
                    onChange={(event) => setMailTaxonomyDraftName(event.currentTarget.value)}
                  />
                </label>
                {mailTaxonomyManagerKind === "folder" ? (
                  <label>
                    <span>父文件夹</span>
                    <select
                      value={mailTaxonomyDraftParentId}
                      onChange={(event) => setMailTaxonomyDraftParentId(event.currentTarget.value)}
                    >
                      <option value="">无父文件夹</option>
                      {mailTaxonomyParentOptions.map(({ item, depth }) => (
                        <option key={item.id} value={item.id}>
                          {"  ".repeat(depth)}
                          {depth > 0 ? "- " : ""}
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label>
                  <span>颜色</span>
                  <div className="nt-mail-taxonomy-modal__color-row">
                    <input
                      type="color"
                      value={mailTaxonomyDraftColor}
                      onChange={(event) => setMailTaxonomyDraftColor(event.currentTarget.value)}
                    />
                    <span>{mailTaxonomyDraftColor}</span>
                  </div>
                </label>
                <div className="nt-mail-taxonomy-modal__actions">
                  <button type="button" onClick={() => resetMailTaxonomyDraft(mailTaxonomyManagerKind)}>
                    新建
                  </button>
                  <button type="submit" className="nt-mail-taxonomy-modal__primary" disabled={busy}>
                    {mailTaxonomyEditingId ? "保存修改" : `创建${mailTaxonomyKindLabel(mailTaxonomyManagerKind)}`}
                  </button>
                </div>
              </section>
              <section className="nt-mail-taxonomy-modal__list" aria-label="已有项目">
                {mailTaxonomyItemsForKind(mailTaxonomyManagerKind).length === 0 ? (
                  <p
                    className="nt-mail-taxonomy-modal__empty"
                    role="status"
                    aria-live="polite"
                    data-empty-state
                  >
                    {mailTaxonomyManagerKind === "folder" ? "暂无自定义文件夹。" : "暂无自定义标签。"}
                  </p>
                ) : (
                  (mailTaxonomyManagerKind === "folder"
                    ? mailFolderTreeItems.map(({ item, depth }) => ({ item, depth }))
                    : mailTaxonomyItemsForKind(mailTaxonomyManagerKind).map((item) => ({ item, depth: 0 }))
                  ).map(({ item, depth }) => (
                    <article
                      key={item.id}
                      className={`nt-mail-taxonomy-modal__item ${
                        mailTaxonomyEditingId === item.id ? "nt-mail-taxonomy-modal__item--editing" : ""
                      }`}
                      style={{ "--taxonomy-depth": depth } as CSSProperties}
                    >
                      <span
                        className={
                          item.kind === "folder"
                            ? "nt-mail-taxonomy__folder-icon"
                            : "nt-mail-taxonomy__dot"
                        }
                        style={{ "--taxonomy-color": item.color } as CSSProperties}
                        aria-hidden="true"
                      />
                      <div>
                        <strong>{item.name}</strong>
                        <small>
                          {item.system ? "系统默认" : "自定义"} · {item.color}
                        </small>
                      </div>
                      <div className="nt-mail-taxonomy-modal__item-actions">
                        <button type="button" onClick={() => selectMailTaxonomyItem(item)}>
                          查看
                        </button>
                        <button type="button" onClick={() => editMailTaxonomyItem(item)}>
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteMailTaxonomyItem(item)}
                          disabled={item.system}
                          title={item.system ? "系统默认项不能删除" : "删除"}
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </section>
            </div>
            <footer className="nt-mail-taxonomy-modal__footer">
              <span>
                文件夹会移动邮件位置；标签不会改变邮件所在文件夹，且一封邮件可以有多个标签。
              </span>
              <button type="button" onClick={closeMailTaxonomyManager}>
                完成
              </button>
            </footer>
          </form>
        </>
      ) : null}
      {contactModalOpen ? (
        <>
          <div className="nt-contact-modal-backdrop" aria-hidden="true" />
          <section
            className="nt-contact-modal"
            role="dialog"
            aria-modal="true"
            aria-label="添加联系人"
            data-modal-id="contact"
            tabIndex={-1}
          >
            <header className="nt-contact-modal__header">
              <strong>创建联系人</strong>
              <button type="button" aria-label="关闭添加联系人" onClick={closeContactModal}>
                ×
              </button>
            </header>
            <div className="nt-contact-modal__form">
              <section className="nt-contact-modal__section nt-contact-modal__identity">
                <label>
                  <span>姓名</span>
                  <div className="nt-contact-modal__split">
                    <input
                      data-modal-initial-focus
                      value={contactDraftFirstName}
                      placeholder="名"
                      aria-label="名"
                      onChange={(event) => setContactDraftFirstName(event.currentTarget.value)}
                    />
                    <input
                      value={contactDraftLastName}
                      placeholder="姓"
                      aria-label="姓"
                      onChange={(event) => setContactDraftLastName(event.currentTarget.value)}
                    />
                  </div>
                </label>
                <label>
                  <span>显示名称</span>
                  <input
                    value={contactDraftDisplayName}
                    placeholder={contactDraftEmail || "写信时显示的名称"}
                    onChange={(event) => setContactDraftDisplayName(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>邮箱地址</span>
                  <div className="nt-contact-modal__email-row">
                  <select aria-label="主要邮箱类型" defaultValue="email">
                    <option value="email">邮箱</option>
                    <option value="work">工作</option>
                    <option value="home">家庭</option>
                  </select>
                  <input
                    value={contactDraftEmail}
                    placeholder="friend@example.com"
                    aria-label="邮箱地址"
                    onChange={(event) => setContactDraftEmail(event.currentTarget.value)}
                  />
                </div>
                </label>
              </section>

              <section className="nt-contact-modal__section">
                <h3>电话号码</h3>
                <input
                  value={contactDraftPhone}
                  placeholder="添加电话号码"
                  aria-label="电话号码"
                  onChange={(event) => setContactDraftPhone(event.currentTarget.value)}
                />
              </section>

              <section className="nt-contact-modal__section">
                <h3>地址</h3>
                <input
                  value={contactDraftAddress}
                  placeholder="添加地址"
                  aria-label="地址"
                  onChange={(event) => setContactDraftAddress(event.currentTarget.value)}
                />
              </section>

              <section className="nt-contact-modal__section nt-contact-modal__two-column">
                <label>
                  <span>生日</span>
                  <input
                    value={contactDraftBirthday}
                    placeholder="YYYY-MM-DD"
                    onChange={(event) => setContactDraftBirthday(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>其他信息</span>
                  <input
                    value={contactDraftOrganization}
                    placeholder="组织"
                    onChange={(event) => setContactDraftOrganization(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>职务</span>
                  <input
                    value={contactDraftTitle}
                    placeholder="角色或职务"
                    onChange={(event) => setContactDraftTitle(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>备注</span>
                  <textarea
                    value={contactDraftNote}
                    placeholder="添加备注"
                    onChange={(event) => setContactDraftNote(event.currentTarget.value)}
                  />
                </label>
              </section>

              <div className="nt-contact-modal__actions">
                <button type="button" onClick={closeContactModal}>
                  取消
                </button>
                <button
                  type="button"
                  className="nt-contact-modal__primary"
                  onClick={() => void createContactFromDraft()}
                  disabled={busy}
                >
                  保存联系人
                </button>
              </div>
            </div>
          </section>
        </>
      ) : null}
      {composeRecipientMenu ? (
        <>
          <div
            className="nt-compose-recipient-menu-backdrop"
            aria-hidden="true"
            onClick={() => setComposeRecipientMenu(null)}
          />
          <section
            id="compose-recipient-menu"
            className="nt-compose-recipient-menu"
            style={{
              left: `${composeRecipientMenu.x}px`,
              top: `${composeRecipientMenu.y}px`,
            }}
            role="menu"
            aria-label="收件人操作"
            data-nonmodal-layer="compose-recipient"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => copyComposeRecipient(composeRecipientMenu.address)}
            >
              复制邮箱地址
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => editComposeRecipient(composeRecipientMenu.field, composeRecipientMenu.address)}
            >
              编辑地址
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                openContactModal(composeRecipientMenu.field, composeRecipientMenu.address)
              }
            >
              创建联系人
            </button>
            <button
              type="button"
              role="menuitem"
              className="nt-compose-recipient-menu__danger"
              onClick={() =>
                removeComposeRecipient(composeRecipientMenu.field, composeRecipientMenu.address)
              }
            >
              移除
            </button>
          </section>
        </>
      ) : null}
      <aside
        className="nt-side-rail"
            aria-label="应用导航"
        data-collapsed={railCollapsed ? "true" : "false"}
      >
        <div className="nt-brand">
          <span className="nt-brand__mark">
            <EasyEmailAppIcon />
          </span>
          <div className="nt-rail-text nt-brand__text">
            <strong>NMail</strong>
          </div>
        </div>

        <div
          className={`nt-mode-switch ${
            railCollapsed ? "nt-mode-switch--collapsed" : "nt-mode-switch--expanded"
          }`}
                  aria-label="邮件模式"
        >
          {railCollapsed ? (
            <button
              type="button"
              className="nt-mode-current"
              aria-label={`Current mode: ${activeRailModeLabel}. Open mode picker`}
              aria-haspopup="menu"
              aria-expanded={railModePickerOpen}
              data-nonmodal-trigger="rail-mode"
              title={activeRailModeLabel}
              onClick={toggleRailModePicker}
            >
              <span className="nt-mode-option__icon">
                <RailIcon kind={railMode} />
              </span>
            </button>
          ) : (
            <>
              <button
                type="button"
                data-mode="mail"
                className={`nt-mode-option ${railMode === "mail" ? "nt-mode-option--active" : ""}`}
                aria-pressed={railMode === "mail"}
                    title="邮件"
                onClick={() => selectRailMode("mail")}
              >
                <span className="nt-mode-option__icon">
                  <RailIcon kind="mail" />
                </span>
              </button>
              <button
                type="button"
                data-mode="agent"
                className={`nt-mode-option ${railMode === "agent" ? "nt-mode-option--active" : ""}`}
                aria-pressed={railMode === "agent"}
                    title="代理"
                onClick={() => selectRailMode("agent")}
              >
                <span className="nt-mode-option__icon">
                  <RailIcon kind="agent" />
                </span>
              </button>
            </>
          )}
        </div>

        <div className="nt-nav-shell">
          {railNavScrollState.top ? (
            <span className="nt-nav-scroll-hint nt-nav-scroll-hint--top" aria-hidden="true" />
          ) : null}
          <nav ref={railNavRef} className="nt-nav" onScroll={updateRailNavScrollState}>
            {railMode === "mail" ? (
            MAIL_RAIL_ITEMS.filter((item) => item.id !== "folders" && item.id !== "labels").map((item) => {
              const count = mailRailCounts[item.id];
              const badge = formatRailBadgeCount(count);
              const active =
                item.id === "compose"
                  ? composePopoverOpen
                  : activeView === "mail" && mailboxView === item.id;
              return (
                <button
                  type="button"
                  key={item.id}
                  data-view={item.id === "compose" ? "compose" : "mail"}
                  data-mail-rail-item={item.id}
                  aria-label={badge ? `${item.label}, ${count} unread or pending` : item.label}
                  aria-expanded={item.id === "compose" ? composePopoverOpen : undefined}
                  aria-controls={item.id === "compose" ? "compose-popover" : undefined}
                  data-nonmodal-trigger={item.id === "compose" ? "compose-popover" : undefined}
                  title={item.label}
                  className={`nt-nav__item ${
                    item.id === "compose" ? "nt-nav__item--primary" : ""
                  } ${active ? "nt-nav__item--active" : ""}`}
                  onClick={
                    item.id === "compose"
                      ? openComposePopover
                      : () => selectMailRailItem(item.id as MailboxView)
                  }
                >
                  <span className="nt-nav__icon">
                    <RailIcon kind={item.id} />
                    {badge ? <span className="nt-nav__badge">{badge}</span> : null}
                  </span>
                  <strong className="nt-nav__label nt-rail-text">{item.label}</strong>
                </button>
              );
            })
            ) : null}
            {railMode === "mail" ? (
          <div className="nt-mail-taxonomy" aria-label="文件夹与标签">
              <section className="nt-mail-taxonomy__section">
                <div className="nt-mail-taxonomy__head">
                  <button
                    type="button"
                    className="nt-mail-taxonomy__icon-toggle"
                    data-modal-return-focus="mail-taxonomy"
                    aria-label={mailTaxonomySectionExpanded.folder ? "收起文件夹" : "展开文件夹"}
                    aria-expanded={mailTaxonomySectionExpanded.folder}
                    aria-controls="mail-taxonomy-folders"
                    onClick={() => openMailTaxonomySectionFromIcon("folder")}
                  >
                    <span className="nt-nav__icon nt-mail-taxonomy__icon">
                      <RailIcon kind="folders" />
                    </span>
                  </button>
                  {railExpandedReady ? (
                    <div className="nt-mail-taxonomy__row">
                      <button
                        type="button"
                        className="nt-mail-taxonomy__add"
                        aria-label="新建文件夹"
                        onClick={() => void createMailTaxonomyItem("folder")}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="nt-mail-taxonomy__chevron"
                        aria-label={mailTaxonomySectionExpanded.folder ? "收起文件夹" : "展开文件夹"}
                        aria-expanded={mailTaxonomySectionExpanded.folder}
                        aria-controls="mail-taxonomy-folders"
                        onClick={() => toggleMailTaxonomySection("folder")}
                      >
                        {mailTaxonomySectionExpanded.folder ? "⌃" : "⌄"}
                      </button>
                    </div>
                  ) : null}
                </div>
                <div id="mail-taxonomy-folders" hidden={!mailTaxonomySectionExpanded.folder}>
                  {mailTaxonomySectionExpanded.folder ? (
                    isMailTaxonomyDrawerOpen("folder") ? (
                    <div className="nt-mail-taxonomy__drawer" role="group" aria-label="文件夹">
                      <div className="nt-mail-taxonomy__drawer-head">
                        <button type="button" className="nt-mail-taxonomy__drawer-title" onClick={() => selectMailRailItem("folders")}>
                          <strong>文件夹</strong>
                        </button>
                        <button
                          type="button"
                          className="nt-mail-taxonomy__add"
                          aria-label="新建文件夹"
                          onClick={() => void createMailTaxonomyItem("folder")}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="nt-mail-taxonomy__chevron"
                          aria-label="收起文件夹"
                          onClick={() => toggleMailTaxonomySection("folder")}
                        >
                          ⌃
                        </button>
                      </div>
                      {mailFolders.length === 0 ? (
                        <p
                          className="nt-mail-taxonomy__empty nt-rail-text"
                          role="status"
                          aria-live="polite"
                          data-empty-state
                        >
                          无文件夹
                        </p>
                      ) : renderMailTaxonomyFolderItems()}
                    </div>
                  ) : mailFolders.length === 0 ? (
                    <p
                      className="nt-mail-taxonomy__empty nt-rail-text"
                      role="status"
                      aria-live="polite"
                      data-empty-state
                    >
                      无文件夹
                    </p>
                  ) : (
                    renderMailTaxonomyFolderItems()
                    )
                  ) : null}
                </div>
              </section>

              <section className="nt-mail-taxonomy__section">
                <div className="nt-mail-taxonomy__head">
                  <button
                    type="button"
                    className="nt-mail-taxonomy__icon-toggle"
                    data-modal-return-focus="mail-taxonomy"
                    aria-label={mailTaxonomySectionExpanded.label ? "收起标签" : "展开标签"}
                    aria-expanded={mailTaxonomySectionExpanded.label}
                    aria-controls="mail-taxonomy-labels"
                    onClick={() => openMailTaxonomySectionFromIcon("label")}
                  >
                    <span className="nt-nav__icon nt-mail-taxonomy__icon">
                      <RailIcon kind="labels" />
                    </span>
                  </button>
                  {railExpandedReady ? (
                    <div className="nt-mail-taxonomy__row">
                      <button
                        type="button"
                        className="nt-mail-taxonomy__add"
                        aria-label="新建标签"
                        onClick={() => void createMailTaxonomyItem("label")}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="nt-mail-taxonomy__chevron"
                        aria-label={mailTaxonomySectionExpanded.label ? "收起标签" : "展开标签"}
                        aria-expanded={mailTaxonomySectionExpanded.label}
                        aria-controls="mail-taxonomy-labels"
                        onClick={() => toggleMailTaxonomySection("label")}
                      >
                        {mailTaxonomySectionExpanded.label ? "⌃" : "⌄"}
                      </button>
                    </div>
                  ) : null}
                </div>
                <div id="mail-taxonomy-labels" hidden={!mailTaxonomySectionExpanded.label}>
                  {mailTaxonomySectionExpanded.label ? (
                    isMailTaxonomyDrawerOpen("label") ? (
                    <div className="nt-mail-taxonomy__drawer" role="group" aria-label="标签">
                      <div className="nt-mail-taxonomy__drawer-head">
                        <button type="button" className="nt-mail-taxonomy__drawer-title" onClick={() => selectMailRailItem("labels")}>
                          <strong>标签</strong>
                        </button>
                        <button
                          type="button"
                          className="nt-mail-taxonomy__add"
                          aria-label="新建标签"
                          onClick={() => void createMailTaxonomyItem("label")}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="nt-mail-taxonomy__chevron"
                          aria-label="收起标签"
                          onClick={() => toggleMailTaxonomySection("label")}
                        >
                          ⌃
                        </button>
                      </div>
                      {mailLabels.length === 0 ? (
                        <p
                          className="nt-mail-taxonomy__empty nt-rail-text"
                          role="status"
                          aria-live="polite"
                          data-empty-state
                        >
                          无标签
                        </p>
                      ) : renderMailTaxonomyLabelItems()}
                    </div>
                  ) : mailLabels.length === 0 ? (
                    <p
                      className="nt-mail-taxonomy__empty nt-rail-text"
                      role="status"
                      aria-live="polite"
                      data-empty-state
                    >
                      无标签
                    </p>
                  ) : (
                    renderMailTaxonomyLabelItems()
                    )
                  ) : null}
                </div>
              </section>
            </div>
            ) : null}
            {railMode === "agent" ? (
            <button
              type="button"
              data-view="agent"
              aria-label={
                agentRailBadge ? `Agent Mail, ${agentRailBadgeCount} needs attention` : "Agent Mail"
              }
              title="代理邮件"
              className={`nt-nav__item ${activeView === "agent" ? "nt-nav__item--active" : ""}`}
              onClick={() => {
                setRailMode("agent");
                setActiveView("agent");
              }}
            >
              <span className="nt-nav__icon">
                <RailIcon kind="agent" />
                {agentRailBadge ? <span className="nt-nav__badge">{agentRailBadge}</span> : null}
              </span>
              <strong className="nt-nav__label nt-rail-text">代理邮件</strong>
            </button>
            ) : null}
            {railMode === "agent" ? (
            <button
              type="button"
              data-view="queue"
              aria-label={queueRailBadge ? `Queue, ${queueRailBadgeCount} pending` : "Queue"}
              title="发送队列"
              className={`nt-nav__item ${activeView === "queue" ? "nt-nav__item--active" : ""}`}
              onClick={() => setActiveView("queue")}
            >
              <span className="nt-nav__icon">
                <RailIcon kind="queue" />
                {queueRailBadge ? <span className="nt-nav__badge">{queueRailBadge}</span> : null}
              </span>
              <strong className="nt-nav__label nt-rail-text">发送队列</strong>
            </button>
            ) : null}
          </nav>
          {railNavScrollState.bottom ? (
            <span className="nt-nav-scroll-hint nt-nav-scroll-hint--bottom" aria-hidden="true" />
          ) : null}
        </div>

        <div className="nt-rail-footer">
          <button
            type="button"
            data-view="setup"
            className={`nt-rail-footer-action ${
              activeView === "setup" ? "nt-rail-footer-action--active" : ""
            }`}
            aria-label="设置"
            title="设置"
            onClick={() => setActiveView("setup")}
          >
            <span className="nt-rail-footer-action__icon">
              <RailIcon kind="setup" />
            </span>
            <span className="nt-rail-text nt-rail-footer-action__copy">
              <strong>设置</strong>
            </span>
          </button>

          {railCollapsed ? (
            <button
              type="button"
              className="nt-rail-toggle nt-platform-account-collapsed-toggle"
              aria-label="展开导航"
              title="展开导航"
              aria-pressed={railCollapsed}
              onClick={expandRail}
            >
              <span className="nt-rail-toggle__icon" aria-hidden="true">
                <RailChevronIcon direction="right" />
              </span>
              <span className="nt-rail-toggle__label nt-rail-text">展开</span>
            </button>
          ) : (
            <div
              className={`nt-platform-account-control nt-platform-account-control--expanded ${
                platformAccountSignedIn
                  ? "nt-platform-account-control--signed-in"
                  : "nt-platform-account-control--signed-out"
              }`}
            >
              {platformAccountSignedIn ? (
                <>
                  <button
                    type="button"
                    className="nt-platform-avatar-button"
                    aria-label="上传平台账户图标"
                    title="上传平台账户图标"
                    onClick={choosePlatformAvatarFile}
                  >
                    <span className="nt-platform-avatar" aria-hidden="true">
                      {platformAccountAvatarDataUrl ? (
                        <img src={platformAccountAvatarDataUrl} alt="" />
                      ) : (
                        platformAccountInitial
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="nt-platform-account-name-button"
                    aria-label="平台账户"
                    title={`${platformAccountName} / ${platformAccountEmail} / ${platformAccountMeta}`}
                    aria-expanded={platformAccountMenuOpen}
                    aria-haspopup="dialog"
                    data-nonmodal-trigger="platform-account"
                    onClick={openPlatformAccountPopover}
                  >
                    <span className="nt-rail-text nt-platform-account-copy">
                      <strong className="nt-platform-account-name">{platformAccountName}</strong>
                    </span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="nt-platform-account-login-button"
                  aria-label="登录平台账户"
                  onClick={() => void signInPlatformAccount()}
                  disabled={busy}
                >
                  预览登录
                </button>
              )}
              <button
                type="button"
                className="nt-rail-toggle nt-platform-account-collapse-toggle"
                aria-label="收起导航"
                title="收起导航"
                aria-pressed={railCollapsed}
                onClick={collapseRail}
              >
                <span className="nt-rail-toggle__icon" aria-hidden="true">
                  <RailChevronIcon direction="left" />
                </span>
                <span className="nt-rail-toggle__label nt-rail-text">收起</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      <section className="nt-workspace-board">
        {activeView === "mail" ? (
          <section className="nt-board-view nt-board-view--mail">
            <div className="nt-mail-topbar">
              <form
                className="nt-mail-search-region"
                role="search"
                onSubmit={submitMailSearch}
              >
                <div className="nt-mail-search-bar">
                  <label
                    className={`nt-mail-top-search ${
                      mailSearchOverlayOpen ? "nt-mail-top-search--active" : ""
                    }`}
                  >
                    <span className="nt-mail-top-search__icon">
                      <SearchMagnifierIcon />
                    </span>
                    <input
                      value={mailSearchQuery}
                      placeholder="搜索邮件"
                      aria-label="搜索邮件"
                      aria-haspopup="dialog"
                      aria-expanded={mailSearchOverlayOpen}
                      aria-controls="mail-search-overlay"
                      data-nonmodal-trigger="mail-search"
                      onFocus={() => setMailSearchOverlayOpen(true)}
                      onChange={(event) => setMailSearchQuery(event.currentTarget.value)}
                    />
                    {mailSearchQuery ? (
                      <button
                        type="button"
                        className="nt-mail-top-search__clear"
                        aria-label="清空搜索"
                        onClick={() => setMailSearchQuery("")}
                      >
                        清除
                      </button>
                    ) : null}
                  </label>
                  <div className="nt-mail-search-actions">
                    <button
                      type="button"
                      className={`nt-mail-search-code-switch ${
                        onlyCodes ? "nt-mail-search-code-switch--active" : ""
                      }`}
                      aria-label="仅显示包含验证码的邮件"
                      aria-pressed={onlyCodes}
                      onClick={() => setOnlyCodes((value) => !value)}
                    >
                      {onlyCodes ? "CODES on" : "CODES"}
                    </button>
                    <button
                      type="button"
                      className={`nt-mail-search-sync-button ${
                        mailSyncInProgress ? "nt-mail-search-sync-button--syncing" : ""
                      }`}
                      aria-label="同步当前邮箱"
                      aria-busy={mailSyncInProgress}
                      title={mailSyncInProgress ? `Syncing ${selectedMailSource.label}` : `Sync ${selectedMailSource.label}`}
                      onClick={() => {
                        closeMailSearchOverlay();
                        void syncCurrentMailSource();
                      }}
                      disabled={busy || mailSyncInProgress}
                    >
                      {mailSyncInProgress ? "SYNCING" : "SYNC"}
                    </button>
                  </div>
                </div>

              {mailSearchOverlayOpen ? (
                <div
                  id="mail-search-overlay"
                  className="nt-mail-search-overlay"
                  role="dialog"
                  aria-label="邮件搜索选项"
                  data-nonmodal-layer="mail-search"
                  data-nonmodal-preserve-focus
                >
                  <div className="nt-mail-search-overlay__header">
                    <strong>搜索选项</strong>
                    <button
                      type="button"
                      className="nt-mail-search-overlay__close"
                      aria-label="关闭搜索选项"
                      title="关闭搜索选项"
                      onClick={closeMailSearchOverlay}
                    >
                      ×
                    </button>
                  </div>
                  <div className="nt-mail-search-overlay__row nt-mail-search-overlay__row--fulltext">
                    <span>
                      <strong>搜索邮件全文</strong>
                      <em>?</em>
                    </span>
                    <button
                      type="button"
                      className={`nt-mail-search-toggle ${
                        mailSearchFullText ? "nt-mail-search-toggle--active" : ""
                      }`}
                      role="switch"
                      aria-label="搜索邮件全文"
                      aria-checked={mailSearchFullText}
                      onClick={() => setMailSearchFullText((value) => !value)}
                    >
                      <span>{mailSearchFullText ? "✓" : ""}</span>
                    </button>
                  </div>

                  <div className="nt-mail-search-group">
                    <strong className="nt-mail-search-label">搜索范围</strong>
                    <div className="nt-mail-search-scope-row">
                      {MAIL_SEARCH_PRIMARY_SCOPES.map((scope) => (
                        <button
                          type="button"
                          key={scope.id}
                          className={`nt-mail-search-scope-chip ${
                            mailSearchScope === scope.id ? "nt-mail-search-scope-chip--active" : ""
                          }`}
                          onClick={() => selectMailSearchScope(scope.id)}
                        >
                          {scope.label}
                        </button>
                      ))}
                      <div className="nt-mail-search-other">
                        <button
                          type="button"
                          className={`nt-mail-search-scope-chip ${
                            !MAIL_SEARCH_PRIMARY_SCOPES.some((scope) => scope.id === mailSearchScope)
                              ? "nt-mail-search-scope-chip--active"
                              : ""
                          }`}
                           data-search-scope="other"
                           aria-haspopup="menu"
                           aria-expanded={mailSearchOtherMenuOpen}
                           aria-controls="mail-search-other-menu"
                           data-nonmodal-trigger="mail-search-other"
                          onClick={() => setMailSearchOtherMenuOpen((value) => !value)}
                        >
                          其他 <span>⌄</span>
                        </button>
                        {mailSearchOtherMenuOpen ? (
                          <div
                            id="mail-search-other-menu"
                            className="nt-mail-search-folder-menu"
                            role="menu"
                            aria-label="其他搜索范围"
                            data-nonmodal-layer="mail-search-other"
                          >
                            <label className="nt-mail-search-folder-menu__filter">
                              <SearchMagnifierIcon />
                              <input
                                value={mailSearchFolderFilter}
                                placeholder="搜索文件夹"
                                onChange={(event) => setMailSearchFolderFilter(event.currentTarget.value)}
                              />
                            </label>
                            <strong>系统文件夹</strong>
                            {filteredMailSearchOtherScopes.length > 0 ? (
                              filteredMailSearchOtherScopes.map((scope) => (
                                <button
                                  type="button"
                                  key={scope.id}
                                  className={
                                    mailSearchScope === scope.id
                                      ? "nt-mail-search-folder-menu__item nt-mail-search-folder-menu__item--active"
                                      : "nt-mail-search-folder-menu__item"
                                  }
                                  role="menuitem"
                                  onClick={() => selectMailSearchScope(scope.id)}
                                >
                                  <span>{scope.icon}</span>
                                  {scope.label}
                                </button>
                              ))
                            ) : (
                              <p
                                className="nt-mail-search-folder-menu__empty"
                                aria-live="polite"
                                data-empty-state
                              >
                                没有匹配的文件夹
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="nt-mail-search-overlay__divider" />

                  <div className="nt-mail-search-overlay__actions">
                    <button
                      type="button"
                      className="nt-mail-search-secondary"
                      onClick={() => setMailSearchAdvancedOpen((value) => !value)}
                    >
                      {mailSearchAdvancedOpen ? "收起搜索选项" : "展开搜索选项"}
                    </button>
                    <button type="submit" className="nt-mail-search-submit">
                      搜索
                    </button>
                  </div>

                  {mailSearchAdvancedOpen ? (
                    <div className="nt-mail-search-advanced">
                      <div className="nt-mail-search-date-row">
                        <label>
                          从
                          <input
                            type="date"
                            value={mailSearchStartDate}
                            onChange={(event) => setMailSearchStartDate(event.currentTarget.value)}
                            aria-label="起始日期"
                          />
                        </label>
                        <label>
                          到
                          <input
                            type="date"
                            value={mailSearchEndDate}
                            onChange={(event) => setMailSearchEndDate(event.currentTarget.value)}
                            aria-label="结束日期"
                          />
                        </label>
                      </div>
                      <label>
                        发件人
                        <input
                          value={mailSearchSender}
                          placeholder="用户名或邮箱地址"
                          onChange={(event) => setMailSearchSender(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        接收者
                        <input
                          value={mailSearchRecipient}
                          placeholder="用户名或邮箱地址"
                          onChange={(event) => setMailSearchRecipient(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        地址
                        <select
                          value={mailSearchAddress}
                          onChange={(event) => setMailSearchAddress(event.currentTarget.value)}
                        >
                          {mailSearchAddressOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="nt-mail-search-filter-row">
                        <strong>筛选器</strong>
                        <label>
                          <input
                            type="checkbox"
                            checked={mailSearchHasAttachment}
                            onChange={(event) => setMailSearchHasAttachment(event.currentTarget.checked)}
                          />
                          包含附件
                        </label>
                      </div>
                    </div>
                  ) : null}

                  <div className="nt-mail-search-overlay__footer">
                    <span>{mailSearchResultLabel}</span>
                    <span className="nt-mail-search-overlay__footer-actions">
                      <button
                        type="button"
                        className="nt-mail-search-cancel"
                        onClick={closeMailSearchOverlay}
                      >
                        取消
                      </button>
                      {(mailSearchQuery || mailSearchHasAdvancedCriteria || mailSearchScope !== "all-mail") ? (
                        <button type="button" onClick={resetMailSearchOptions}>
                          重置
                        </button>
                      ) : null}
                    </span>
                  </div>
                </div>
              ) : null}
              </form>

              <div className="nt-mail-topbar__actions">
                {mailboxView === "trash" ? (
                  <button
                    type="button"
                    className="nt-btn nt-btn--outline nt-mail-topbar__action"
                    onClick={() => void emptyCurrentTrash()}
                    disabled={busy || trashMessageCount === 0}
                  >
                    清空回收站
                  </button>
                ) : null}
                {selectedMailMessage ? (
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary nt-mail-topbar__action nt-mail-topbar__action--expand"
                    aria-pressed={mailReadingExpanded}
                    onClick={() => setMailReadingExpanded((value) => !value)}
                  >
                    {mailReadingExpanded ? "退出聚焦" : "展开阅读"}
                  </button>
                ) : null}
                <div className="nt-mail-source-selector">
                  <button
                    type="button"
                    className="nt-mail-source-selector__trigger"
                    data-modal-return-focus="mail-account"
                    aria-label="选择当前邮箱账号"
                    aria-haspopup="dialog"
                    aria-expanded={mailSourceDropdownOpen}
                    aria-controls="mail-source-selector-menu"
                    data-nonmodal-trigger="mail-source"
                    title={`当前邮箱账号: ${selectedMailSource.label}`}
                    onClick={() => {
                      closeMailSearchOverlay();
                      setMailSourceDropdownOpen((value) => !value);
                    }}
                  >
                    <span className="nt-mail-source-selector__kicker">当前邮箱账号</span>
                    <strong>{selectedMailSource.label}</strong>
                    <span className="nt-mail-source-selector__chevron" aria-hidden="true">
                      {mailSourceDropdownOpen ? "⌃" : "⌄"}
                    </span>
                  </button>
                  {mailSourceDropdownOpen ? (
                    <div
                      id="mail-source-selector-menu"
                      className="nt-mail-source-selector__menu"
                      role="dialog"
                      aria-label="当前邮箱账号与添加操作"
                      data-nonmodal-layer="mail-source"
                    >
                      <div
                        className="nt-mail-source-selector__options"
                        role="listbox"
                        aria-label="当前邮箱账号"
                        data-nonmodal-navigation
                      >
                        {mailSources.map((source) => (
                          <button
                            type="button"
                            key={source.id}
                            className={`nt-mail-source-selector__option nt-mail-source-selector__option--${source.tone} ${
                              mailSourceId === source.id ? "nt-mail-source-selector__option--active" : ""
                            }`}
                            role="option"
                            aria-selected={mailSourceId === source.id}
                            onClick={() => selectMailSource(source.id)}
                          >
                            <strong>{source.label}</strong>
                          </button>
                        ))}
                      </div>
                      <div className="nt-mail-source-selector__actions" role="group" aria-label="添加邮箱操作">
                        <button
                          type="button"
                          className="nt-mail-source-selector__action"
                          onClick={openMailAccountPanelFromSourceDropdown}
                        >
                          添加长效邮箱
                        </button>
                        <button
                          type="button"
                          className="nt-mail-source-selector__action nt-mail-source-selector__action--primary"
                          onClick={createTempMailboxFromSourceDropdown}
                          disabled={busy}
                        >
                          创建并添加临时邮箱
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {mailAccountPanelOpen ? (
              <div className="nt-mail-account-panel-scrim" role="presentation">
                <aside
                  className="nt-mail-account-panel"
                  role="dialog"
                  aria-modal="true"
                  aria-label="添加长效邮箱"
                  data-modal-id="mail-account"
                  tabIndex={-1}
                >
                  <div className="nt-mail-account-panel__head">
                    <div>
                      <p className="nt-kicker">长效邮箱</p>
                      <h2>添加邮箱</h2>
                    </div>
                    <button
                      type="button"
                      className="nt-mini-btn"
                      onClick={() => setMailAccountPanelOpen(false)}
                    >
                      关闭
                    </button>
                  </div>

                  <div className="nt-mail-account-panel__preset">
                    <button
                      type="button"
                      className="nt-btn nt-btn--secondary"
                      onClick={applyQqMailPreset}
                    >
                      QQ 邮箱预设
                    </button>
                    <span>QQ 邮箱 / IMAP 993 / TLS / 使用授权码（SMTP 在 M5）</span>
                  </div>

                  <div className="nt-scroll-pane nt-mail-account-panel__body">
                    <div className="nt-form-grid">
                      <label>
                        显示名称
                        <input
                          data-modal-initial-focus
                          value={normalDisplayName}
                          placeholder="QQ Mail"
                          onChange={(event) => setNormalDisplayName(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        邮箱地址
                        <input
                          value={normalEmailAddress}
                          placeholder="123456@qq.com"
                          onChange={(event) => updateNormalEmailAddress(event.currentTarget.value)}
                        />
                      </label>
                      <label className="nt-wide-field">
                        授权码
                        <input
                          type="password"
                          value={normalImapPassword}
                          placeholder="QQ 邮箱授权码"
                          onChange={(event) => updateMailboxAuthorizationCode(event.currentTarget.value)}
                        />
                      </label>
                      <div className="nt-derived-grid nt-wide-field">
                        <span>登录</span>
                        <strong>{mailboxLoginUsername() || "邮箱地址"}</strong>
                        <span>收取</span>
                        <strong>
                          {normalImapHost || "imap.qq.com"}:{normalImapPort || "993"}
                        </strong>
                        <span>发送</span>
                        <strong>SMTP 将在 M5 迁移</strong>
                      </div>
                      <button
                        type="button"
                        className="nt-mini-btn nt-wide-field"
                        onClick={() => setMailAccountPanelAdvancedOpen((value) => !value)}
                      >
                        {mailAccountPanelAdvancedOpen ? "隐藏高级设置" : "高级服务器设置"}
                      </button>
                      {mailAccountPanelAdvancedOpen ? (
                        <>
                          <label>
                            IMAP 主机
                            <input
                              value={normalImapHost}
                              placeholder="imap.qq.com"
                              onChange={(event) => setNormalImapHost(event.currentTarget.value)}
                            />
                          </label>
                          <label>
                            IMAP 端口
                            <input
                              value={normalImapPort}
                              inputMode="numeric"
                              placeholder="993"
                              onChange={(event) => setNormalImapPort(event.currentTarget.value)}
                            />
                          </label>
                          <label>
                            IMAP 安全模式
                            <select
                              value={normalImapSecurity}
                              onChange={(event) => setNormalImapSecurity(
                                event.currentTarget.value as ManualImapAccountCreateRequest["imap_security"],
                              )}
                            >
                              <option value="tls">TLS</option>
                              <option value="starttls">STARTTLS</option>
                            </select>
                          </label>
                          <p className="nt-form-note nt-wide-field">
                            当前 M3 只保存 IMAP 配置。SMTP 主机、端口和发信凭据将在 M5 发送队列切片中迁移。
                          </p>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="nt-mail-account-panel__foot">
                    <button
                      type="button"
                      className="nt-btn nt-btn--primary"
                      onClick={() => void addManualImapAccount()}
                      disabled={busy}
                    >
                      保存并测试 IMAP
                    </button>
                  </div>
                </aside>
              </div>
            ) : null}

            <div
              className={`nt-mail-adaptive ${
                mailSourceDrawerOpen ? "nt-mail-adaptive--drawer-open" : ""
              } ${mailReadingExpanded ? "nt-mail-adaptive--reading" : ""} ${
                visibleMailMessages.length === 0 ? "nt-mail-adaptive--empty" : ""
              }`}
            >
              <div className="nt-mail-list-toolbar">
                <div className="nt-mail-list-toolbar__row-main">
                  <div className="nt-mail-list-toolbar__group">
                    {displayedMailMessages.length > 0 ? (
                      <div className="nt-mail-list-toolbar__menu-anchor">
                        <div className="nt-mail-list-toolbar__select-group">
                          <button
                            type="button"
                            className={`nt-mail-list-select ${
                              allVisibleMailMessagesSelected ? "nt-mail-list-select--checked" : ""
                            } ${someVisibleMailMessagesSelected ? "nt-mail-list-select--partial" : ""}`}
                            aria-label="选择当前页邮件"
                            aria-pressed={allVisibleMailMessagesSelected}
                            onClick={toggleSelectAllVisibleMailMessages}
                          >
                            <span className="nt-mail-list-select__box" aria-hidden="true">
                              {allVisibleMailMessagesSelected ? "✓" : someVisibleMailMessagesSelected ? "−" : ""}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="nt-mail-list-toolbar__trigger"
                            aria-label="打开选择菜单"
                            aria-haspopup="menu"
                            aria-expanded={mailListSelectionMenuOpen}
                            aria-controls="mail-list-selection-menu"
                            data-nonmodal-trigger="mail-list-selection"
                            onClick={() => {
                              const nextOpen = !mailListSelectionMenuOpen;
                              closeMailListToolbarMenus();
                              setMailListSelectionMenuOpen(nextOpen);
                            }}
                          >
                            <MailListToolbarIcon kind="chevron-down" />
                          </button>
                        </div>
                        {renderMailListSelectionMenu()}
                      </div>
                    ) : null}
                    <div
                      className="nt-mail-list-toolbar__mailbox-title"
                      aria-label={`当前邮箱 ${onlyCodes ? "CODES" : selectedMailboxLabel}：${displayedMailMessages.length} 封邮件`}
                    >
                      <strong>{onlyCodes ? "CODES" : selectedMailboxLabel}</strong>
                      <span className="nt-mail-list-toolbar__mailbox-count">
                        {displayedMailMessages.length}
                      </span>
                    </div>
                    {mailListHasSelection ? (
              <div className="nt-mail-list-toolbar__selected-actions" aria-label="选中邮件操作">
                        <button
                          type="button"
                          className="nt-mail-list-toolbar__action"
                  aria-label="标记选中邮件"
                          title={selectedMailMessagesHaveUnread ? "标记为已读" : "标记为未读"}
                          onClick={() => void markSelectedMailMessagesRead(selectedMailMessagesHaveUnread)}
                          disabled={busy}
                        >
                          <MailListToolbarIcon kind="mark-read" />
                        </button>
                        <span className="nt-mail-list-toolbar__divider--vertical" aria-hidden="true" />
                        {mailListPrimaryMoveActions.map((action) => renderMailListPrimaryMoveAction(action))}
                        <span className="nt-mail-list-toolbar__divider--vertical" aria-hidden="true" />
                        <div className="nt-mail-list-toolbar__menu-anchor">
                          <button
                            type="button"
                            className="nt-mail-list-toolbar__action"
                            aria-label="移动选中邮件"
                            title="移动"
                            aria-haspopup="dialog"
                            aria-expanded={mailListMoveMenuOpen}
                            aria-controls="mail-list-move-panel"
                            data-nonmodal-trigger="mail-list-move"
                            onClick={() => {
                              const nextOpen = !mailListMoveMenuOpen;
                              closeMailListToolbarMenus();
                              setMailListMoveTarget("");
                              setMailListMoveSearch("");
                              setMailListMoveMenuOpen(nextOpen);
                            }}
                            disabled={busy}
                          >
                            <MailListToolbarIcon kind="move" />
                          </button>
                          {renderMailListMoveMenu()}
                        </div>
                        <div className="nt-mail-list-toolbar__menu-anchor">
                          <button
                            type="button"
                            className="nt-mail-list-toolbar__action"
                            aria-label="为选中邮件添加标签"
                            title="标签"
                            aria-haspopup="dialog"
                            aria-expanded={mailListLabelMenuOpen}
                            aria-controls="mail-list-label-panel"
                            data-nonmodal-trigger="mail-list-label"
                            onClick={() => {
                              const nextOpen = !mailListLabelMenuOpen;
                              closeMailListToolbarMenus();
                              if (nextOpen) {
                                resetMailListLabelDraftFromSelection();
                                setMailListLabelSearch("");
                                setMailListLabelArchiveAfterApply(false);
                              }
                              setMailListLabelMenuOpen(nextOpen);
                            }}
                            disabled={busy}
                          >
                            <MailListToolbarIcon kind="label" />
                          </button>
                          {renderMailListLabelMenu()}
                        </div>
                        <div className="nt-mail-list-toolbar__menu-anchor">
                          <button
                            type="button"
                            className="nt-mail-list-toolbar__action"
                            aria-label="推迟选中邮件"
                            title="推迟通知"
                            aria-haspopup="dialog"
                            aria-expanded={mailListSnoozeMenuOpen}
                            aria-controls="mail-list-snooze-panel"
                            data-nonmodal-trigger="mail-list-snooze"
                            onClick={() => {
                              const nextOpen = !mailListSnoozeMenuOpen;
                              closeMailListToolbarMenus();
                              setMailListSnoozeMenuOpen(nextOpen);
                            }}
                            disabled={busy}
                          >
                            <MailListToolbarIcon kind="clock" />
                          </button>
                          {renderMailListSnoozeMenu()}
                        </div>
                      </div>
                    ) : displayedMailMessages.length > 0 ? (
                      <>
                        <div className="nt-mail-list-toolbar__menu-anchor">
                          <button
                            type="button"
                            className="nt-mail-list-toolbar__action nt-mail-list-toolbar__action--more"
                            aria-label="更多邮箱操作"
                            title="更多"
                            aria-haspopup="menu"
                            aria-expanded={mailListBulkMenuOpen}
                            aria-controls="mail-list-more-menu"
                            data-nonmodal-trigger="mail-list-more"
                            onClick={() => {
                              const nextOpen = !mailListBulkMenuOpen;
                              closeMailListToolbarMenus();
                              setMailListBulkMenuOpen(nextOpen);
                            }}
                            disabled={busy || displayedMailMessages.length === 0}
                          >
                            <MailListToolbarIcon kind="more" />
                          </button>
                          {renderMailListMoreMenu()}
                        </div>
                      </>
                    ) : null}
                  </div>

                  {visibleMailMessages.length > 0 ||
                  mailListReadFilter !== "all" ||
                  mailListHasAttachmentOnly ? (
                  <div className="nt-mail-list-toolbar__right">
                    <button
                      type="button"
                      className={`nt-mail-list-toolbar__unread-toggle ${
                        mailListReadFilter === "unread" ? "nt-mail-list-toolbar__unread-toggle--active" : ""
                      }`}
                      aria-label="只显示未读邮件"
                      aria-pressed={mailListReadFilter === "unread"}
                      onClick={toggleMailListUnreadOnly}
                    >
                      <span className="nt-mail-list-toolbar__unread-check" aria-hidden="true">
                        {mailListReadFilter === "unread" ? "✓" : ""}
                      </span>
                      未读
                    </button>
                    <div className="nt-mail-list-toolbar__menu-anchor">
                      <button
                        type="button"
                        className="nt-mail-list-toolbar__filter"
                        aria-label="打开列表筛选"
                        aria-haspopup="menu"
                        aria-expanded={mailListFilterMenuOpen}
                        aria-controls="mail-list-filter-menu"
                        data-nonmodal-trigger="mail-list-filter"
                        onClick={() => {
                          const nextOpen = !mailListFilterMenuOpen;
                          closeMailListToolbarMenus();
                          setMailListFilterMenuOpen(nextOpen);
                        }}
                      >
                        <MailListToolbarIcon kind="filter" />
                        <span className="nt-mail-list-toolbar__filter-label">筛选器</span>
                      </button>
                      {renderMailListFilterMenu()}
                    </div>
              <div className="nt-mail-list-toolbar__pager" aria-label="邮件列表分页">
                      <button
                        type="button"
                  aria-label="上一页邮件"
                        onClick={() => goToMailListPage(clampedMailListCurrentPage - 1)}
                        disabled={clampedMailListCurrentPage === 0}
                      >
                        <MailListToolbarIcon kind="chevron-left" />
                      </button>
                      <span>
                        {displayedMailConversations.length === 0
                          ? "0/0"
                          : `${mailListPageStart + 1}-${mailListPageEnd}/${displayedMailConversations.length}`}
                      </span>
                      <button
                        type="button"
                  aria-label="下一页邮件"
                        onClick={() => goToMailListPage(clampedMailListCurrentPage + 1)}
                        disabled={clampedMailListCurrentPage >= mailListTotalPages - 1}
                      >
                        <MailListToolbarIcon kind="chevron-right" />
                      </button>
                    </div>
                  </div>
                  ) : null}
                </div>
              </div>

              <section className="nt-list-pane">
                {mailboxView === "newsletters" ? (
                  <section
                    className="nt-newsletter-subscriptions"
                aria-label="订阅邮件管理"
                  >
                    <div className="nt-newsletter-subscriptions__head">
                  <strong>订阅管理</strong>
                      <span>
                        {displayedNewsletterSubscriptions.length}
                        {hiddenNewsletterSubscriptionCount > 0
                          ? ` / ${hiddenNewsletterSubscriptionCount} hidden`
                          : ""}
                      </span>
                    </div>
                    {hiddenNewsletterSubscriptionCount > 0 ? (
                      <button
                        type="button"
                        className="nt-newsletter-subscriptions__toggle"
                        onClick={() =>
                          setShowHiddenNewsletterSubscriptions((current) => !current)
                        }
                      >
                        {showHiddenNewsletterSubscriptions ? "Hide hidden subscriptions" : "Show hidden subscriptions"}
                      </button>
                    ) : null}
                    {selectedNewsletterSubscription ? (
                      <button
                        type="button"
                        className="nt-newsletter-subscriptions__filter"
                        onClick={() => setSelectedNewsletterSubscription(null)}
                      >
                        Clear subscription filter
                      </button>
                    ) : null}
                    {displayedNewsletterSubscriptions.length > 0 ? (
                      <div className="nt-newsletter-subscriptions__grid">
                        {displayedNewsletterSubscriptions.slice(0, 6).map((subscription) => (
                          <article
                            key={`${subscription.account_id}:${subscription.id}`}
                            className={`nt-newsletter-subscription-card ${
                              subscription.spam ? "nt-newsletter-subscription-card--spam" : ""
                            } ${
                              subscription.hidden ? "nt-newsletter-subscription-card--hidden" : ""
                            } ${
                              selectedNewsletterSubscription?.accountId === subscription.account_id &&
                              selectedNewsletterSubscription.subscriptionId === subscription.id
                                ? "nt-newsletter-subscription-card--active"
                                : ""
                            }`}
                          >
                            <button
                              type="button"
                              className="nt-newsletter-subscription-card__open"
                              aria-pressed={
                                selectedNewsletterSubscription?.accountId ===
                                  subscription.account_id &&
                                selectedNewsletterSubscription.subscriptionId === subscription.id
                              }
                              onClick={() => selectNewsletterSubscription(subscription)}
                            >
                              <strong>{subscription.name}</strong>
                              <span>{subscription.sender_address}</span>
                              <small>
                                {subscription.received_message_count} messages ·{" "}
                                {subscription.unread_message_count} unread
                              </small>
                              {subscription.unsubscribe_methods.length > 0 ? (
                                <em>可取消订阅</em>
                              ) : null}
                            </button>
                            <div className="nt-newsletter-subscription-card__actions">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleNewsletterSubscriptionHidden(
                                    subscription,
                                    !subscription.hidden,
                                  );
                                }}
                              >
                                {subscription.hidden ? "Restore" : "Hide"}
                              </button>
                              <button
                                type="button"
                                disabled={subscription.unsubscribe_methods.length === 0}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleNewsletterUnsubscribe(subscription);
                                }}
                              >
                                Unsubscribe
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p
                        className="nt-newsletter-subscriptions__empty"
                        role="status"
                        aria-live="polite"
                        data-empty-state
                      >
                        Sync a mailbox with List-ID or List-Unsubscribe headers to build
                        subscription groups.
                      </p>
                    )}
                  </section>
                ) : null}

                <div className="nt-scroll-pane">
                  {onlyCodes ? (
                    paginatedCodeBackedMailMessages.length > 0 ? (
                      paginatedCodeBackedMailMessages.map((message) => (
                        <div
                          className={`nt-message-card nt-message-card--compact nt-message-card--code nt-message-card--selectable ${
                            selectedMailMessageId === message.message_id
                              ? "nt-message-card--active"
                              : ""
                          } ${message.is_read ? "" : "nt-message-card--unread"}`}
                          key={`${message.sourceLabel}:${message.message_id}`}
                        >
                          <button
                            type="button"
                            className="nt-message-card__select"
                            aria-label={`选择邮件 ${message.subject}`}
                            aria-pressed={selectedMailMessageIdsSet.has(message.message_id)}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleMailMessageSelection(message.message_id);
                            }}
                          >
                            <span className="nt-message-card__checkbox" aria-hidden="true">
                              {selectedMailMessageIdsSet.has(message.message_id) ? "✓" : ""}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="nt-message-code nt-message-code-copy"
                            aria-label={`复制验证码 ${message.verificationCode.code}`}
                            onClick={(event) =>
                              void copyVerificationCode(event, message.verificationCode.code)
                            }
                          >
                            {message.verificationCode.code}
                          </button>
                          <SenderAvatarIcon
                            value={message.from_address}
                            avatar={senderAvatarFor(message.from_address)}
                            compact={true}
                            onAvatarClick={openAvatarEditor}
                          />
                          <button
                            type="button"
                            className="nt-message-card__content nt-message-card__open"
                            aria-label={`打开邮件 ${message.subject}`}
                            onClick={() => openMailMessage(message)}
                          >
                            <span className="nt-message-card__mainline">
                              <span className="nt-message-card__subject-line">
                                {!message.is_read ? (
                                  <span className="nt-message-card__unread-dot" aria-hidden="true" />
                                ) : null}
                                <strong>{message.subject}</strong>
                              </span>
                              <time
                                className="nt-message-card__time"
                                dateTime={message.observed_at}
                              >
                                {formatMailListTime(message.observed_at)}
                              </time>
                            </span>
                            <span>{message.snippet || "暂无预览内容"}</span>
                            {renderMailListStateRow(message)}
                          </button>
                        </div>
                      ))
                    ) : (
                      <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                        {codeBackedMailMessages.length === 0 && visibleMailMessages.length > 0
                          ? "Synced mail has no detected codes."
                          : "No verification codes detected yet."}
                      </p>
                    )
                  ) : displayedMailConversations.length > 0 ? (
                    paginatedDisplayedMailConversations.map((conversation) => {
                      const conversationMessageIds = conversation.messages.map(
                        (item) => item.message_id,
                      );
                      const conversationSelected =
                        conversationMessageIds.length > 0 &&
                        conversationMessageIds.every((messageId) =>
                          selectedMailMessageIdsSet.has(messageId),
                        );
                      return (
                        <MailConversationCard
                          key={`${conversation.latestMessage.sourceLabel}:${conversation.key}`}
                          conversation={conversation}
                          active={selectedMailConversation?.key === conversation.key}
                          selected={conversationSelected}
                          senderAvatar={senderAvatarFor(conversation.latestMessage.from_address)}
                          AvatarComponent={SenderAvatarIcon}
                          formatTime={formatMailListTime}
                          onOpen={onCardOpen}
                          onToggleSelected={onCardToggleSelected}
                          onAvatarClick={onCardAvatarClick}
                        />
                      );
                    })
                  ) : (
                    <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                      暂无{selectedMailboxLabel}邮件。请添加邮箱或执行同步。
                    </p>
                  )}
                </div>
              </section>

              {visibleMailMessages.length > 0 ? (
              <article className="nt-reading-pane">
                {selectedMailMessage ? (
                  <div className="nt-proton-reading">
                    <section className="nt-proton-message-card" aria-label="当前邮件">
                      <header className="nt-proton-message-header">
                        <SenderAvatarIcon
                          value={selectedMailMessage.from_address}
                          avatar={senderAvatarFor(selectedMailMessage.from_address)}
                          onAvatarClick={openAvatarEditor}
                        />
                        <div className="nt-proton-header-main">
                          <div className="nt-proton-header-line">
                            <strong>{displayNameFromAddress(selectedMailMessage.from_address)}</strong>
                            <span>{extractEmailAddress(selectedMailMessage.from_address)}</span>
                          </div>
                          <div className="nt-proton-recipient-line">
                            <span>收件人</span>
                            <strong>{selectedMessageToAddress || "当前邮箱"}</strong>
                          </div>
                        </div>
                        <div className="nt-proton-header-meta">
                          <div className="nt-proton-header-time-row">
                            <button
                              type="button"
                              className="nt-proton-star"
                              onClick={() => void toggleSelectedMailStarred()}
                              disabled={busy}
                              title="本地星标"
                            >
                              {selectedMailMessage.is_starred ? "已星标" : "星标"}
                            </button>
                            <span>{selectedMailMessage.observed_at}</span>
                          </div>
                          <div className="nt-proton-header-actions">
                            <div className="nt-proton-header-navigation" aria-label="邮件导航">
                              <button
                                type="button"
                                className="nt-proton-icon-btn"
                                aria-label="上一封邮件"
                                onClick={() => openAdjacentMailMessage(-1)}
                                disabled={!canGoPreviousMailMessage || busy}
                                title="上一封邮件"
                              >
                                上一封
                              </button>
                              <button
                                type="button"
                                className="nt-proton-icon-btn"
                                aria-label="下一封邮件"
                                onClick={() => openAdjacentMailMessage(1)}
                                disabled={!canGoNextMailMessage || busy}
                                title="下一封邮件"
                              >
                                下一封
                              </button>
                            </div>
                            <button
                              type="button"
                              className="nt-proton-primary-reply"
                              onClick={draftReplyToMail}
                              disabled={!canDraftReply || !selectedReplyAccountCanSend || busy}
                                title={
                                  selectedReplyAccountCanSend
                                    ? "创建回复草稿"
                                    : "请先为该账户配置 SMTP 后再回复"
                                }
                              >
                              回复
                            </button>
                            <div className="nt-proton-message-more-anchor">
                              <button
                                 type="button"
                                 className="nt-proton-icon-btn nt-proton-message-more-trigger"
                                 aria-label="更多邮件操作"
                                 aria-haspopup="menu"
                                  aria-expanded={
                                    mailMessageMoreMenuOpen || mailMoveMenuOpen || mailLabelMenuOpen
                                  }
                                  aria-controls={
                                    mailMoveMenuOpen
                                      ? "mail-message-move-menu"
                                      : mailLabelMenuOpen
                                        ? "mail-message-label-menu"
                                        : "mail-message-more-menu"
                                  }
                                 data-nonmodal-trigger="mail-message-more mail-message-move mail-message-label"
                                 onClick={() => {
                                  setMailMoveMenuOpen(false);
                                  setMailLabelMenuOpen(false);
                                  setMailMessageMoreMenuOpen((value) => !value);
                                }}
                                disabled={!selectedMailMessage || busy}
                              >
                                ...
                              </button>
                              {mailMessageMoreMenuOpen ? (
                                 <div
                                   id="mail-message-more-menu"
                                   className="nt-proton-message-more-menu"
                                   role="menu"
                                   aria-label="更多邮件操作"
                                   data-nonmodal-layer="mail-message-more"
                                 >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setMailMessageMoreMenuOpen(false);
                                      draftReplyAllToMail();
                                    }}
                                    disabled={!canDraftReply || !selectedReplyAccountCanSend || busy}
                                  >
                                    全部回复
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setMailMessageMoreMenuOpen(false);
                                      draftForwardMail();
                                    }}
                                    disabled={!canDraftReply || !selectedReplyAccountCanSend || busy}
                                  >
                                    转发
                                  </button>
                                   <span className="nt-proton-message-more-menu__divider" role="separator" />
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setMailMessageMoreMenuOpen(false);
                                      void markSelectedMailMessageRead(!selectedMailMessageIsRead);
                                    }}
                                    disabled={!selectedMailMessage || busy}
                                  >
                                    {selectedMailMessageIsRead ? "标记为未读" : "标记为已读"}
                                  </button>
                                  {mailboxView === "trash" ? (
                                    <>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                          setMailMessageMoreMenuOpen(false);
                                          void restoreSelectedMailMessage();
                                        }}
                                        disabled={busy}
                                      >
                                        恢复
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="nt-proton-message-more-menu__danger"
                                        onClick={() => {
                                          setMailMessageMoreMenuOpen(false);
                                          void deleteSelectedMailMessageForever();
                                        }}
                                        disabled={busy}
                                      >
                                        永久删除
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                          setMailMessageMoreMenuOpen(false);
                                          void archiveSelectedMailMessage();
                                        }}
                                        disabled={busy}
                                      >
                                        归档
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="nt-proton-message-more-menu__danger"
                                        onClick={() => {
                                          setMailMessageMoreMenuOpen(false);
                                          void deleteSelectedMailMessage();
                                        }}
                                        disabled={busy}
                                      >
                                        删除
                                      </button>
                                    </>
                                  )}
                                   <span className="nt-proton-message-more-menu__divider" role="separator" />
                                   <button
                                     type="button"
                                     role="menuitem"
                                    onClick={() => {
                                      setMailMessageMoreMenuOpen(false);
                                      setMailLabelMenuOpen(false);
                                      setMailMoveMenuOpen((value) => !value);
                                    }}
                                    disabled={busy}
                                  >
                                    移动到
                                  </button>
                                   <button
                                     type="button"
                                     role="menuitem"
                                    onClick={() => {
                                      setMailMessageMoreMenuOpen(false);
                                      setMailMoveMenuOpen(false);
                                      setMailLabelMenuOpen((value) => !value);
                                    }}
                                    disabled={busy}
                                  >
                                    添加标签
                                  </button>
                                   <button
                                     type="button"
                                     role="menuitem"
                                    onClick={() => {
                                      setMailMessageMoreMenuOpen(false);
                                      void setSelectedMailFlag("important", !selectedMailMessage.is_important);
                                    }}
                                    disabled={busy}
                                  >
                                    {selectedMailMessage.is_important ? "取消重要标记" : "标记为重要"}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </header>

                      {mailMoveMenuOpen ? (
                        <div
                          id="mail-message-move-menu"
                          className="nt-proton-action-menu"
                          role="menu"
                          aria-label="移动邮件"
                          data-nonmodal-layer="mail-message-move"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void moveSelectedMailMessage("inbox")}
                            disabled={busy}
                          >
                            Inbox
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void moveSelectedMailMessage("later")}
                            disabled={busy}
                          >
                            Later
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void moveSelectedMailMessage("spam")}
                            disabled={busy}
                          >
                            Spam
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void moveSelectedMailMessage("archive")}
                            disabled={busy}
                          >
                            Archive
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void moveSelectedMailMessage("trash")}
                            disabled={busy}
                          >
                            Trash
                          </button>
                          {localFolderOptions.length > 0 ? (
                            <span className="nt-proton-action-menu__divider" />
                          ) : null}
                          {localFolderOptions.map((folder) => (
                            <button
                              type="button"
                              role="menuitem"
                              key={folder.id}
                              onClick={() => void moveSelectedMailMessage(folder.name)}
                              disabled={busy}
                            >
                              <span
                                className="nt-proton-action-menu__color"
                                style={{ "--taxonomy-color": folder.color } as CSSProperties}
                                aria-hidden="true"
                              />
                              {folder.name}
                            </button>
                          ))}
                        </div>
                      ) : null}

                      {mailLabelMenuOpen ? (
                        <div
                          id="mail-message-label-menu"
                          className="nt-proton-action-menu"
                          role="menu"
                          aria-label="为邮件添加标签"
                          data-nonmodal-layer="mail-message-label"
                        >
                          {localLabelOptions.map((label) => {
                            const enabled = selectedMailMessage.labels.some(
                              (value) => normalizeMailToken(value) === normalizeMailToken(label.name),
                            );
                            return (
                              <button
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={enabled}
                                key={label.id}
                                onClick={() => void labelSelectedMailMessage(label.name, !enabled)}
                                disabled={busy}
                              >
                                <span
                                  className="nt-proton-action-menu__color"
                                  style={{ "--taxonomy-color": label.color } as CSSProperties}
                                  aria-hidden="true"
                                />
                                {enabled ? "移除" : "添加"} {label.name}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}

                      <div className="nt-proton-message-body-wrap">
                        {selectedMailConversationMessages.length > 1 ? (
                        <div className="nt-proton-conversation-stack" aria-label="邮件会话">
                            <div className="nt-proton-conversation-summary">
                              Conversation · {selectedMailConversationMessages.length} messages
                              {selectedMailConversation?.unreadCount
                                ? ` · ${selectedMailConversation.unreadCount} unread`
                                : ""}
                            </div>
                            {selectedMailConversationMessages.map((conversationMessage, index) => {
                              const expanded = conversationMessage.message_id === selectedMailMessageId;
                              const bodySource = expanded ? selectedMailMessage : conversationMessage;
                              return (
                                <section
                                  className={`nt-proton-conversation-message ${
                                    expanded ? "nt-proton-conversation-message--expanded" : ""
                                  }`}
                                  key={conversationMessage.message_id}
                                >
                                  <button
                                    type="button"
                                    className="nt-proton-conversation-message__header"
                                    onClick={() => openMailMessage(conversationMessage)}
                                    disabled={busy}
                                  >
                                    <SenderAvatarIcon
                                      value={conversationMessage.from_address}
                                      avatar={senderAvatarFor(conversationMessage.from_address)}
                                      compact={true}
                                    />
                                    <span>
                                      <strong>{displayNameFromAddress(conversationMessage.from_address)}</strong>
                                      <small>{conversationMessage.snippet || conversationMessage.subject}</small>
                                    </span>
                                    <time dateTime={conversationMessage.observed_at}>
                                      {formatMailListTime(conversationMessage.observed_at)}
                                    </time>
                                  </button>
                                  {expanded ? (
                                    "body_html" in bodySource && bodySource.body_html ? (
                                      <iframe
                                        className="nt-message-html-frame"
                                        title={`邮件正文 ${index + 1}/${selectedMailConversationMessages.length}：${displayNameFromAddress(conversationMessage.from_address)} · ${conversationMessage.subject}`}
                                        loading="lazy"
                                        sandbox="allow-same-origin allow-popups"
                                        scrolling="no"
                                        onLoad={resizeMessageHtmlFrame}
                                        srcDoc={bodySource.body_html}
                                      />
                                    ) : (
                                      <div className="nt-message-body">
                                        {renderLinkedMessageText(
                                          "body_text" in bodySource
                                            ? bodySource.body_text ?? bodySource.snippet
                                            : bodySource.snippet,
                                          openUrl,
                                        )}
                                      </div>
                                    )
                                  ) : null}
                                </section>
                              );
                            })}
                          </div>
                        ) : "body_html" in selectedMailMessage && selectedMailMessage.body_html ? (
                          <iframe
                            className="nt-message-html-frame"
                            title={`邮件正文：${displayNameFromAddress(selectedMailMessage.from_address)} · ${selectedMailMessage.subject}`}
                            loading="lazy"
                            sandbox="allow-same-origin allow-popups"
                            scrolling="no"
                            onLoad={resizeMessageHtmlFrame}
                            srcDoc={selectedMailMessage.body_html}
                          />
                        ) : (
                          <div className="nt-message-body">
                            {renderLinkedMessageText(
                              "body_text" in selectedMailMessage
                                ? selectedMailMessage.body_text ?? selectedMailMessage.snippet
                                : selectedMailMessage.snippet,
                              openUrl,
                            )}
                          </div>
                        )}
                      </div>
                    </section>
                  </div>
                ) : (
                  <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                    选择一封邮件开始阅读。
                  </p>
                )}
              </article>
              ) : null}

              {mailSourceDrawerOpen ? (
              <aside id="mail-source-drawer" className="nt-source-drawer" aria-label="邮件来源抽屉">
                  <div className="nt-source-drawer__head">
                    <div>
                    <p className="nt-kicker">邮件来源</p>
                    <h2>选择邮件来源</h2>
                    </div>
                    <button
                      type="button"
                      className="nt-mini-btn"
                      onClick={() => setMailSourceDrawerOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                  <div className="nt-source-list">
                    {mailSources.map((source) => (
                      <button
                        type="button"
                        key={source.id}
                        className={`nt-source-card nt-source-card--${source.tone} ${
                          mailSourceId === source.id ? "nt-source-card--active" : ""
                        }`}
                        onClick={() => selectMailSource(source.id)}
                      >
                        <strong>{source.label}</strong>
                      </button>
                    ))}
                  </div>
                  <div className="nt-divider" />
                  <button
                    type="button"
                    className="nt-btn nt-btn--primary"
                    onClick={createTempMailbox}
                    disabled={busy}
                  >
                    New temp mailbox
                  </button>
                </aside>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeView === "agent" ? (
          <section className="nt-board-view">
            <div className="nt-board-head">
              <div>
                <p className="nt-kicker">AGENT MAIL</p>
                <h1>Task thread control</h1>
                <span>Agent accounts are scope=agent and hidden from normal Mail.</span>
              </div>
              <div className="nt-board-actions">
                <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void loadAgentThreads()}>
                  Refresh threads
                </button>
                <button
                  type="button"
                  className="nt-btn nt-btn--primary"
                  onClick={() => setAgentWorkspace("compose")}
                >
                  Compose task
                </button>
              </div>
            </div>

            <div className="nt-agent-layout">
              <aside className="nt-directory">
                <p className="nt-kicker">WORKSPACE</p>
                <div className="nt-source-list">
                  {([
                    ["threads", "Threads", `${agentThreads.length}`],
                    ["attention", "Needs attention", `${needsAttentionThreads.length}`],
                    ["compose", "Compose", selectedAgentService?.trust_level ?? "target"],
                    ["services", "Services", `${agentServices.length}`],
                  ] as const).map(([id, label, meta]) => (
                    <button
                      type="button"
                      key={id}
                      className={`nt-source-card ${agentWorkspace === id ? "nt-source-card--active" : ""}`}
                      onClick={() => setAgentWorkspace(id)}
                    >
                      <strong>{label}</strong>
                      <span>{meta}</span>
                    </button>
                  ))}
                </div>
                <div className="nt-divider" />
                <span className="nt-badge nt-badge--signal">scope=agent</span>
                <span className="nt-badge nt-badge--cyan">remote services are not accounts</span>
              </aside>

              {agentWorkspace === "threads" || agentWorkspace === "attention" ? (
                <>
                  <section className="nt-list-pane">
                    <div className="nt-pane-head">
                      <p className="nt-kicker">
                        {agentWorkspace === "attention" ? "UNMATCHED" : "THREADS"}
                      </p>
                      <span>
                        {agentWorkspace === "attention"
                          ? needsAttentionThreads.length
                          : agentThreads.length}
                      </span>
                    </div>
                    <div className="nt-scroll-pane">
                      {(agentWorkspace === "attention" ? needsAttentionThreads : agentThreads).length > 0 ? (
                        (agentWorkspace === "attention" ? needsAttentionThreads : agentThreads).map((thread) => (
                          <button
                            type="button"
                            className="nt-thread-card"
                            key={thread.id}
                            onClick={() => void loadAgentThreadDetail(thread.id)}
                          >
                            <strong>{thread.subject}</strong>
                            <span>{thread.correlation_key}</span>
                            <small>{thread.status}</small>
                          </button>
                        ))
                      ) : (
                        <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                          No Agent threads in this lane.
                        </p>
                      )}
                    </div>
                  </section>

                  <article className="nt-reading-pane nt-reading-pane--dark">
                    <p className="nt-kicker">THREAD DETAIL</p>
                    {selectedAgentThreadDetail ? (
                      <>
                        <h2>{selectedAgentThreadDetail.thread.subject}</h2>
                        <div className="nt-meta-grid">
                          <span>Status</span>
                          <strong>{selectedAgentThreadDetail.thread.status}</strong>
                          <span>Service</span>
                          <strong>{selectedAgentThreadDetail.thread.agent_service_id}</strong>
                          <span>Sender</span>
                          <strong>{selectedAgentThreadDetail.thread.sender_account_id}</strong>
                        </div>
                        <div className="nt-timeline">
                          {selectedAgentThreadDetail.messages.map((message) => (
                            <article className="nt-timeline-item" key={message.id}>
                              <span>{message.direction}</span>
                              <div>
                                <strong>{message.semantic_role}</strong>
                                <small>
                                  {message.parsed_status ?? "unknown"} / {message.created_at}
                                </small>
                              </div>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                        Open a thread to inspect outgoing task mail and replies.
                      </p>
                    )}
                  </article>
                </>
              ) : null}

              {agentWorkspace === "compose" ? (
                <section className="nt-action-board">
                  <div className="nt-form-grid">
                    <label>
                      Task sender
                      <select
                        value={selectedAgentSenderId ?? ""}
                        onChange={(event) => setSelectedAgentSenderId(event.currentTarget.value || null)}
                      >
                        <option value="">Select send-enabled Agent account</option>
                        {sendEnabledAgentAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.display_name} - {account.primary_address ?? account.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Remote Agent service
                      <select
                        value={selectedAgentServiceId ?? ""}
                        onChange={(event) => setSelectedAgentServiceId(event.currentTarget.value || null)}
                      >
                        <option value="">Select remote Agent service</option>
                        {agentServices.map((service) => (
                          <option key={service.id} value={service.id}>
                            {service.display_name} - {service.trust_level}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="nt-wide-field">
                      Task subject
                      <input
                        value={agentTaskSubject}
                        placeholder="Research task"
                        onChange={(event) => setAgentTaskSubject(event.currentTarget.value)}
                      />
                    </label>
                    <label className="nt-wide-field">
                      Task body
                      <textarea
                        value={agentTaskBody}
                        placeholder="Describe the task for the remote Agent"
                        onChange={(event) => setAgentTaskBody(event.currentTarget.value)}
                      />
                    </label>
                    <label className="nt-check">
                      <input
                        type="checkbox"
                        checked={confirmRestrictedAgent}
                        onChange={(event) => setConfirmRestrictedAgent(event.currentTarget.checked)}
                      />
                      Confirm restricted service send
                    </label>
                  </div>
                  <div className="nt-actions">
                    <button type="button" className="nt-btn nt-btn--primary" onClick={() => void sendAgentTask()} disabled={busy}>
                      Queue Agent task
                    </button>
                    <span className="nt-badge nt-badge--signal">
                      {selectedAgentService?.trust_level ?? "no service"}
                    </span>
                    <span className="nt-badge nt-badge--cyan">
                      {selectedAgentSender?.primary_address ?? "no sender"}
                    </span>
                  </div>
                  {lastAgentTask ? (
                    <div className="nt-result">
                      <strong>Last Agent task</strong>
                      <span>
                        Thread {lastAgentTask.thread.id} is {lastAgentTask.thread.status}; queue{" "}
                        {lastAgentTask.queue_id} is {lastAgentTask.queue_status}.
                      </span>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {agentWorkspace === "services" ? (
                <section className="nt-action-board nt-action-board--split">
                  <div>
                    <p className="nt-kicker">MY AGENT MAILBOXES</p>
                    <div className="nt-scroll-pane nt-scroll-pane--short">
                      {agentAccounts.length > 0 ? (
                        agentAccounts.map((account) => (
                          <article className="nt-resource-row" key={account.id}>
                            <strong>{account.display_name}</strong>
                            <span>{account.primary_address ?? "No address"}</span>
                            <small>
                              {account.scope} / {account.send_status} / hidden{" "}
                              {account.listed_in_all_accounts ? "no" : "yes"}
                            </small>
                          </article>
                        ))
                      ) : (
                        <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                          No Agent sender accounts yet.
                        </p>
                      )}
                    </div>
                    <div className="nt-form-grid nt-form-grid--single">
                      <label>
                        Agent account name
                        <input
                          value={agentDisplayName}
                          placeholder="Agent Sender"
                          onChange={(event) => setAgentDisplayName(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        Agent account email
                        <input
                          value={agentEmailAddress}
                          placeholder="agent@example.com"
                          onChange={(event) => setAgentEmailAddress(event.currentTarget.value)}
                        />
                      </label>
                      <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void addAgentAccount()} disabled={busy}>
                        Add Agent account
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className="nt-kicker">REMOTE SERVICES</p>
                    <div className="nt-scroll-pane nt-scroll-pane--short">
                      {agentServices.length > 0 ? (
                        agentServices.map((service) => (
                          <article className="nt-resource-row" key={service.id}>
                            <strong>{service.display_name}</strong>
                            <span>{service.email_address}</span>
                            <small>{service.trust_level} / {service.status}</small>
                          </article>
                        ))
                      ) : (
                        <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                          No remote Agent services yet.
                        </p>
                      )}
                    </div>
                    <div className="nt-form-grid nt-form-grid--single">
                      <label>
                        Service name
                        <input
                          value={agentServiceName}
                          placeholder="Remote Agent"
                          onChange={(event) => setAgentServiceName(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        Service email
                        <input
                          value={agentServiceEmail}
                          placeholder="remote-agent@example.com"
                          onChange={(event) => setAgentServiceEmail(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        Trust level
                        <select
                          value={agentTrustLevel}
                          onChange={(event) => setAgentTrustLevel(event.currentTarget.value)}
                        >
                          <option value="trusted">trusted</option>
                          <option value="restricted">restricted</option>
                          <option value="blocked">blocked</option>
                          <option value="unknown">unknown</option>
                        </select>
                      </label>
                      <label>
                        Description
                        <textarea
                          value={agentServiceDescription}
                          placeholder="What this Agent service is allowed to handle"
                          onChange={(event) => setAgentServiceDescription(event.currentTarget.value)}
                        />
                      </label>
                      <button type="button" className="nt-btn nt-btn--primary" onClick={() => void addAgentService()} disabled={busy}>
                        Add remote service
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeView === "queue" ? (
          <section className="nt-board-view">
            <div className="nt-board-head">
              <div>
                <p className="nt-kicker">SEND QUEUE</p>
                <h1>SMTP dispatch board</h1>
                <span>Outgoing mail is queued and processed by worker runs.</span>
              </div>
              <div className="nt-board-actions">
                <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void loadSendQueue()}>
                  Refresh queue
                </button>
                <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void runSendQueueWorkerOnce()} disabled={busy}>
                  Run worker
                </button>
              </div>
            </div>

            <div className="nt-two-column">
              <section className="nt-action-board">
                <div className="nt-form-grid nt-form-grid--single">
                  <label>
                    Sender account
                    <select
                      value={selectedNormalAccountId ?? ""}
                      onChange={(event) => {
                        const accountId = event.currentTarget.value || null;
                        setSelectedNormalAccountId(accountId);
                        setStatusMessage("Canonical SMTP and message history become available in M5/M6.");
                      }}
                    >
                      <option value="">Select send-enabled account</option>
                      {sendEnabledAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.display_name} - {account.primary_address ?? account.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Target address
                    <input
                      value={sendTargetAddress}
                      placeholder="target@example.com"
                      onChange={(event) => setSendTargetAddress(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Subject
                    <input
                      value={sendSubject}
                      placeholder="Task or message subject"
                      onChange={(event) => setSendSubject(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Body
                    <textarea
                      value={sendBodyText}
                      placeholder="Queued SMTP body"
                      onChange={(event) => setDraftBodyText(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <button type="button" className="nt-btn nt-btn--primary" onClick={() => void enqueueDraftSend()} disabled={busy}>
                  Queue send
                </button>
                {lastSend ? (
                  <div className="nt-result">
                    <strong>Last queued send</strong>
                    <span>
                      Message {lastSend.message_id} entered queue {lastSend.queue_id} as{" "}
                      {lastSend.status}.
                    </span>
                  </div>
                ) : null}
                {lastSendWorkerRun ? (
                  <div className="nt-result">
                    <strong>Last worker run</strong>
                    <span>
                      processed {lastSendWorkerRun.processed_count}, sent {lastSendWorkerRun.sent_count},
                      retry {lastSendWorkerRun.retry_count}, failed {lastSendWorkerRun.failed_count}
                    </span>
                  </div>
                ) : null}
              </section>

              <section className="nt-list-pane nt-list-pane--wide">
                <div className="nt-pane-head">
                  <p className="nt-kicker">QUEUE ITEMS</p>
                  <span>{sendQueue.length}</span>
                </div>
                <div className="nt-scroll-pane">
                  {sendQueue.length > 0 ? (
                    sendQueue.map((item) => (
                      <article className="nt-resource-row" key={item.id}>
                        <strong>{item.subject}</strong>
                        <span>To: {item.target_address}</span>
                        <small>
                          {item.status} / attempts {item.attempt_count} / {item.updated_at}
                        </small>
                      </article>
                    ))
                  ) : (
                    <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                      No send queue items yet.
                    </p>
                  )}
                </div>
              </section>
            </div>
          </section>
        ) : null}

        {activeView === "setup" ? (
          <section className="nt-board-view">
            <div className="nt-board-head">
              <div>
                <p className="nt-kicker">SETUP</p>
                <h1>Provider and mailbox ignition</h1>
                <span>Configure EasyEmail, long-lived IMAP accounts, and temporary mailbox creation.</span>
              </div>
            </div>

            <div className="nt-two-column">
              <section className="nt-action-board">
                <p className="nt-kicker">EASYEMAIL</p>
                <div className="nt-form-grid nt-form-grid--single">
                  <label>
                    Service URL
                    <input
                      value={serviceUrl}
                      placeholder="http://127.0.0.1:8080"
                      onChange={(event) => setServiceUrl(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    One-shot API token
                    <input
                      type="password"
                      value={apiToken}
                      placeholder="Not stored in SQLite"
                      onChange={(event) => setApiToken(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <div className="nt-actions">
                  <button type="button" className="nt-btn nt-btn--primary" onClick={saveSettings} disabled={busy}>
                    Save URL
                  </button>
                  <button type="button" className="nt-btn nt-btn--secondary" onClick={testConnection} disabled={busy}>
                    Test connection
                  </button>
                </div>
                {easyEmailHealth ? (
                  <div className="nt-result">
                    <strong>{easyEmailHealth.reachable ? "Reachable" : "Unreachable"}</strong>
                    <span>{easyEmailHealth.capabilities_summary}</span>
                    <small>Auth: {easyEmailHealth.auth_status}</small>
                  </div>
                ) : null}

                <div className="nt-divider" />
                <p className="nt-kicker">SENDER AVATARS</p>
                <div className="nt-form-grid nt-form-grid--single">
                  <label className="nt-check">
                    <input
                      type="checkbox"
                      checked={avatarSettings.remote_enabled}
                      onChange={(event) =>
                        setAvatarSettings((current) => ({
                          ...current,
                          remote_enabled: event.currentTarget.checked,
                        }))
                      }
                    />
                    Fetch remote sender avatars by default
                  </label>
                  <label className="nt-check">
                    <input
                      type="checkbox"
                      checked={avatarSettings.bimi_enabled}
                      onChange={(event) =>
                        setAvatarSettings((current) => ({
                          ...current,
                          bimi_enabled: event.currentTarget.checked,
                        }))
                      }
                    />
                    Prefer BIMI logo records
                  </label>
                  <label className="nt-check">
                    <input
                      type="checkbox"
                      checked={avatarSettings.favicon_enabled}
                      onChange={(event) =>
                        setAvatarSettings((current) => ({
                          ...current,
                          favicon_enabled: event.currentTarget.checked,
                        }))
                      }
                    />
                    Fallback to HTTPS favicon
                  </label>
                  <label className="nt-check">
                    <input
                      type="checkbox"
                      checked={avatarSettings.auth_enabled}
                      onChange={(event) =>
                        setAvatarSettings((current) => ({
                          ...current,
                          auth_enabled: event.currentTarget.checked,
                        }))
                      }
                    />
                    Resolve SPF / DKIM / DMARC / BIMI signals
                  </label>
                </div>
                <div className="nt-actions">
                  <button
                    type="button"
                    className="nt-btn nt-btn--primary"
                    onClick={() => void saveAvatarSettings()}
                    disabled={busy}
                  >
                    Save avatar settings
                  </button>
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary"
                    onClick={() => void clearSenderAvatarCache(false)}
                    disabled={busy}
                  >
                    Clear remote cache
                  </button>
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary"
                    onClick={() => void clearSenderAvatarCache(true)}
                    disabled={busy}
                  >
                    Clear all avatars
                  </button>
                </div>

                <div className="nt-divider" />
                <p className="nt-kicker">TEMP MAILBOX</p>
                <div className="nt-form-grid nt-form-grid--single">
                  <label>
                    Target service
                    <input
                      value={targetService}
                      placeholder="github, openai, custom..."
                      onChange={(event) => setTargetService(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Note
                    <input
                      value={note}
                      placeholder="Why this mailbox was created"
                      onChange={(event) => setNote(event.currentTarget.value)}
                    />
                  </label>
                  <label className="nt-check">
                    <input
                      type="checkbox"
                      checked={waitForCode}
                      onChange={(event) => setWaitForCode(event.currentTarget.checked)}
                    />
                    Wait for code after creation
                  </label>
                </div>
                <div className="nt-actions">
                  <button type="button" className="nt-btn nt-btn--primary" onClick={createTempMailbox} disabled={busy}>
                    Create temp mailbox
                  </button>
                  <button type="button" className="nt-btn nt-btn--secondary" onClick={refreshAnonymousMail} disabled={busy}>
                    Refresh anonymous
                  </button>
                </div>
                <div className="nt-divider" />
                <p className="nt-kicker">RECOVER MAILBOX</p>
                <div className="nt-form-grid">
                  <label>
                    Email address
                    <input
                      value={tempRecoveryEmail}
                      placeholder="mailbox@example.test"
                      onChange={(event) => setTempRecoveryEmail(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Provider type (optional)
                    <input
                      value={tempRecoveryProviderType}
                      placeholder="mailtm, m2u..."
                      onChange={(event) => setTempRecoveryProviderType(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <div className="nt-actions">
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary"
                    onClick={() => void recoverTempMailbox()}
                    disabled={busy}
                  >
                    Recover from local core
                  </button>
                </div>
                <small>
                  Recovery uses provider and mailbox state already held by the local core; credentials are not retained by this UI.
                </small>
                <div className="nt-divider" />
                <p className="nt-kicker">MAILBOX ACTIONS</p>
                <div className="nt-form-grid">
                  <label className="nt-wide-field">
                    Temporary mailbox
                    <select
                      value={selectedTempMailboxId}
                      onChange={(event) => setSelectedTempMailboxId(event.currentTarget.value)}
                    >
                      <option value="">Select a mailbox</option>
                      {tempMailboxes.map((mailbox) => (
                        <option key={mailbox.id} value={mailbox.id}>
                          {mailbox.email_address} ({mailbox.lifecycle_state})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Sender filter
                    <input
                      value={tempMailboxFromContains}
                      placeholder="example.com; blank clears"
                      onChange={(event) => setTempMailboxFromContains(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Failure reason
                    <input
                      value={tempOutcomeFailureReason}
                      placeholder="Rejected domain, provider error..."
                      onChange={(event) => setTempOutcomeFailureReason(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Send to
                    <input
                      value={tempSendTo}
                      placeholder="recipient@example.test"
                      onChange={(event) => setTempSendTo(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Send subject
                    <input
                      value={tempSendSubject}
                      placeholder="Message subject"
                      onChange={(event) => setTempSendSubject(event.currentTarget.value)}
                    />
                  </label>
                  <label className="nt-wide-field">
                    Send body
                    <textarea
                      value={tempSendBody}
                      placeholder="Plain-text message body"
                      onChange={(event) => setTempSendBody(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <div className="nt-actions">
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary"
                    onClick={() => void readTempMailboxAuthenticationLink()}
                    disabled={busy || !selectedTempMailboxId}
                  >
                    Read auth link
                  </button>
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary"
                    onClick={() => void updateTempMailboxSession()}
                    disabled={busy || !selectedTempMailboxId}
                  >
                    Update sender filter
                  </button>
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary"
                    onClick={() => void reportTempMailboxOutcome(true)}
                    disabled={busy || !selectedTempMailboxId}
                  >
                    Report success
                  </button>
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary"
                    onClick={() => void reportTempMailboxOutcome(false)}
                    disabled={busy || !selectedTempMailboxId}
                  >
                    Report failure
                  </button>
                  <button
                    type="button"
                    className="nt-btn nt-btn--primary"
                    onClick={() => void sendTempMailboxMessage()}
                    disabled={busy || !selectedTempMailboxId}
                  >
                    Send from mailbox
                  </button>
                  <button
                    type="button"
                    className="nt-btn nt-btn--secondary"
                    onClick={() => void releaseTempMailbox()}
                    disabled={busy || !selectedTempMailboxId}
                  >
                    Release mailbox
                  </button>
                </div>
                {lastAuthenticationLink ? (
                  <div className="nt-result">
                    <strong>Authentication link</strong>
                    <span>{lastAuthenticationLink.label ?? "Detected action link"}</span>
                    <small>{lastAuthenticationLink.url}</small>
                    <button
                      type="button"
                      className="nt-mini-btn"
                      onClick={() => void openLastTempMailboxAuthenticationLink()}
                    >
                      Open link
                    </button>
                  </div>
                ) : null}
                {lastRefresh ? (
                  <div className="nt-result">
                    <strong>Last refresh</strong>
                    <span>
                      fetched {lastRefresh.fetched_count}, inserted {lastRefresh.inserted_count},
                      skipped {lastRefresh.skipped_count}, failed {lastRefresh.failed_count}
                    </span>
                    {lastRefresh.failures.length > 0 ? (
                      <small>
                        {lastRefresh.failures
                          .map((failure) => `${failure.temp_mailbox_id}: ${failure.error_code}`)
                          .join(", ")}
                      </small>
                    ) : null}
                  </div>
                ) : null}
                {lastPromotion ? (
                  <div className="nt-result">
                    <strong>Last promotion</strong>
                    <span>{lastPromotion.account.display_name} is now {lastPromotion.account.status}.</span>
                  </div>
                ) : null}
                <div className="nt-scroll-pane nt-scroll-pane--short">
                  {tempMailboxes.length > 0 ? (
                    tempMailboxes.map((mailbox) => (
                      <article className="nt-resource-row" key={mailbox.id}>
                        <strong>{mailbox.email_address}</strong>
                        <span>
                          {mailbox.provider_label} / {mailbox.visibility_state} /{" "}
                          {mailbox.lifecycle_state}
                        </span>
                        <small>{mailbox.easyemail_mailbox_id ?? "no EasyEmail session id"}</small>
                        <div className="nt-row-actions">
                          <button
                            type="button"
                            className="nt-mini-btn"
                            onClick={() => void refreshMailbox(mailbox.id)}
                            disabled={busy}
                          >
                            Refresh
                          </button>
                          {mailbox.visibility_state === "anonymous" &&
                          mailbox.easyemail_mailbox_id !== mailbox.id ? (
                            <button
                              type="button"
                              className="nt-mini-btn"
                              onClick={() => void promoteMailbox(mailbox)}
                              disabled={busy}
                            >
                              Promote
                            </button>
                          ) : null}
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                      No temporary mailboxes yet.
                    </p>
                  )}
                </div>
              </section>

              <section className="nt-action-board">
                <div className="nt-section-title-row">
                  <p className="nt-kicker">MAIL ACCOUNT</p>
                  <button
                    type="button"
                    className="nt-mini-btn nt-mini-btn--signal"
                    onClick={applyQqMailPreset}
                  >
                    QQ preset
                  </button>
                </div>
                <div className="nt-form-grid">
                  <label>
                    Display name
                    <input
                      value={normalDisplayName}
                      placeholder="Work"
                      onChange={(event) => setNormalDisplayName(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Email address
                    <input
                      value={normalEmailAddress}
                      placeholder="work@example.com"
                      onChange={(event) => updateNormalEmailAddress(event.currentTarget.value)}
                    />
                  </label>
                  <label className="nt-wide-field">
                    Authorization code
                    <input
                      type="password"
                      value={normalImapPassword}
                      placeholder="QQ authorization code, not QQ login password"
                      onChange={(event) => updateMailboxAuthorizationCode(event.currentTarget.value)}
                    />
                  </label>
                  <div className="nt-derived-grid nt-wide-field">
                    <span>Login</span>
                    <strong>{mailboxLoginUsername() || "email address"}</strong>
                    <span>Receive</span>
                    <strong>
                      {normalImapHost || "imap.qq.com"}:{normalImapPort || "993"}
                    </strong>
                    <span>Send</span>
                    <strong>SMTP migrates in M5</strong>
                  </div>
                  <button
                    type="button"
                    className="nt-mini-btn nt-wide-field"
                    onClick={() => setMailAccountPanelAdvancedOpen((value) => !value)}
                  >
                    {mailAccountPanelAdvancedOpen ? "Hide advanced" : "Advanced server settings"}
                  </button>
                  {mailAccountPanelAdvancedOpen ? (
                    <>
                      <label>
                        IMAP host
                        <input
                          value={normalImapHost}
                          placeholder="imap.example.com"
                          onChange={(event) => setNormalImapHost(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        IMAP port
                        <input
                          value={normalImapPort}
                          inputMode="numeric"
                          placeholder="993"
                          onChange={(event) => setNormalImapPort(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        IMAP security
                        <select
                          value={normalImapSecurity}
                          onChange={(event) => setNormalImapSecurity(
                            event.currentTarget.value as ManualImapAccountCreateRequest["imap_security"],
                          )}
                        >
                          <option value="tls">TLS</option>
                          <option value="starttls">STARTTLS</option>
                        </select>
                      </label>
                      <p className="nt-form-note nt-wide-field">
                        This M3 slice stores IMAP only. SMTP settings and send credentials move with the M5 queue slice.
                      </p>
                    </>
                  ) : null}
                </div>
                <div className="nt-result">
                  <strong>QQ Mail</strong>
                  <span>IMAP imap.qq.com:993 TLS. SMTP setup is deferred to M5.</span>
                  <small>Enable IMAP in QQ Mail web settings and paste the generated authorization code.</small>
                </div>
                <div className="nt-actions">
                  <button type="button" className="nt-btn nt-btn--primary" onClick={() => void addManualImapAccount()} disabled={busy}>
                    Save and test IMAP
                  </button>
                </div>
                {normalImapTest ? (
                  <div className="nt-result">
                    <strong>{normalImapTest.authenticated ? "Authenticated" : "Not authenticated"}</strong>
                    <span>{normalImapTest.capability_summary}</span>
                  </div>
                ) : null}
                <div className="nt-scroll-pane nt-scroll-pane--short">
                  {normalImapAccounts.length > 0 ? (
                    normalImapAccounts.map((account) => (
                      <article className="nt-resource-row" key={account.id}>
                        <strong>{account.display_name}</strong>
                        <span>{account.primary_address ?? "No address"}</span>
                        <small>
                          {account.auth_status} / {account.receive_status} / {account.send_status}
                        </small>
                        <div className="nt-row-actions">
                          <button
                            type="button"
                            className="nt-mini-btn"
                            onClick={() => {
                              setSelectedNormalAccountId(account.id);
                              setMailSourceId(`account:${account.id}`);
                              setStatusMessage("Message synchronization becomes available in M6.");
                            }}
                            disabled={busy}
                          >
                            View
                          </button>
                          <button
                            type="button"
                            className="nt-mini-btn"
                            onClick={() => void testNormalImap(account)}
                            disabled={busy}
                          >
                            Test IMAP
                          </button>
                          {account.status !== "disabled" ? (
                            <button
                              type="button"
                              className="nt-mini-btn"
                              onClick={() => void disableNormalAccount(account)}
                              disabled={busy}
                            >
                              Disable
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="nt-mini-btn"
                            onClick={() => void deleteNormalAccount(account)}
                            disabled={busy}
                          >
                            Delete
                          </button>
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                      No manual IMAP accounts yet.
                    </p>
                  )}
                </div>
              </section>
            </div>
          </section>
        ) : null}
      </section>
      {toastMessage && toastKey && toastVisibleKey === toastKey ? (
        <div
          className={`nt-copy-toast ${
            error
              ? "nt-copy-toast--error"
              : copyToast
                ? "nt-copy-toast--success"
                : "nt-copy-toast--status"
          } ${composePopoverOpen ? "nt-copy-toast--compose-open" : ""} ${
            toastFading ? "nt-copy-toast--fade" : ""
          }`}
          role={error ? "alert" : "status"}
          aria-live={error ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <span className="nt-copy-toast__state" aria-hidden="true">
            {error ? "!" : copyToast ? "✓" : "i"}
          </span>
          <span className="nt-copy-toast__content">
            <span>{toastMessage}</span>
            {error?.correlation_id ? (
              <small>关联 ID: {error.correlation_id}</small>
            ) : null}
          </span>
          <button
            type="button"
            className="nt-copy-toast__dismiss"
            aria-label="关闭通知"
            onClick={dismissCurrentToast}
          >
            ×
          </button>
        </div>
      ) : null}
    </main>
  );
}

export default App;
