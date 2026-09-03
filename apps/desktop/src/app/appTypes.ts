import type { CSSProperties } from "react";
import type { AccountDto } from "../api/mailAccountClient";
import type { MailTaxonomyKind } from "../api/mailTaxonomyClient";
import type { NewsletterSubscriptionDto } from "../api/newsletterClient";
import type { ComposeRecipientField } from "../compose/composeData";
import type { MailConversationSummary as MailConversationSummaryModel } from "../mail/mailSelectors";
import type { TemporaryMailboxRefreshView, TemporaryMailboxView } from "../mail/temporaryMailboxAdapter";
import type { VerificationCodeDto } from "../mail/mailSearch";

export type TempMailboxDto = TemporaryMailboxView;

export type TempRefreshDto = TemporaryMailboxRefreshView;

export type CoreTemporaryState = {
  mailboxes: TempMailboxDto[];
  messages: AnonymousMessageDto[];
  codes: VerificationCodeDto[];
};

export type LegacyAccountDto = Omit<AccountDto, "version" | "credential_refs">;

export type SendMessageDto = {
  message_id: string;
  queue_id: string;
  status: string;
};

export type AgentServiceDto = {
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

export type AgentThreadDto = {
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

export type AgentMessageDto = {
  id: string;
  thread_id: string;
  message_id: string;
  direction: string;
  semantic_role: string;
  parsed_status: string | null;
  created_at: string;
};

export type AgentThreadDetailDto = {
  thread: AgentThreadDto;
  messages: AgentMessageDto[];
};

export type AgentSendTaskDto = {
  thread: AgentThreadDto;
  agent_message: AgentMessageDto;
  queue_id: string;
  queue_status: string;
};

export type AnonymousMessageDto = {
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

export type MailTaxonomySectionExpanded = {
  folder: boolean;
  label: boolean;
};

export type MessageDetailDto = {
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

export type MessageLocalActionDto = {
  message_id: string;
  changed: boolean;
  status: string;
  remote_applied: boolean;
};

export type LocalDraftSaveDto = {
  message_id: string;
  saved_at: string;
};

export type MessageBatchActionDto = {
  requested_count: number;
  changed_count: number;
  remote_applied_count: number;
};

export type PromoteTempMailboxDto = {
  account: LegacyAccountDto;
  mailbox: TempMailboxDto;
};

export type ErrorDto = {
  code: string;
  user_message: string;
  correlation_id: string;
};

export type AppView = "mail" | "agent" | "queue" | "setup";

export type RailMode = "mail" | "agent";

export type MailRailItemId =
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

export type MailboxView = Exclude<MailRailItemId, "compose">;

export type MailSearchScope =
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

export type AgentWorkspace = "threads" | "compose" | "attention" | "services";

export type ComposeRecipientMenuState = {
  field: ComposeRecipientField;
  address: string;
  x: number;
  y: number;
};

export type ComposeContactPickerPosition = Pick<CSSProperties, "left" | "top">;

export type ComposeColorMode = "text" | "background";

export type ComposeMoreMenuAnchor = "toolbar" | "formatbar";

export type ComposeTextDirection = "ltr" | "rtl";

export type ComposeAlignmentValue = "left" | "center" | "right";

export type ComposeActiveFormats = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  unorderedList: boolean;
  orderedList: boolean;
  quote: boolean;
};

export type ComposeSchedulePreset = "custom" | null;

export type ComposeAttachmentDraft = {
  id: string;
  name: string;
  size: number;
};

export type ComposeDraftSnapshot = {
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

export type MailListReadFilter = "all" | "unread" | "read";

export type MailListPrimaryMoveAction = "inbox" | "trash" | "archive" | "spam" | "nospam" | "delete";

export type MailRailItem = {
  id: MailRailItemId;
  label: string;
};

export type MailSearchScopeOption = {
  id: MailSearchScope;
  label: string;
  icon: string;
};

export type MailSource = {
  id: string;
  label: string;
  meta: string;
  tone: "signal" | "cyan" | "info";
};

export type MessageCache = Record<string, AnonymousMessageDto[]>;

export type NewsletterSubscriptionCache = Record<string, NewsletterSubscriptionDto[]>;

export type VisibleNewsletterSubscription = NewsletterSubscriptionDto & {
  account_id: string;
};

export type SelectedMailTaxonomyFilter = {
  kind: MailTaxonomyKind;
  name: string;
} | null;

export type VisibleMailMessage = AnonymousMessageDto & {
  sourceLabel: string;
  sourceId: string;
  body_text?: string | null;
  account_id?: string;
};

export type CodeBackedMailMessage = VisibleMailMessage & {
  verificationCode: VerificationCodeDto;
};

export type MailConversationSummary = MailConversationSummaryModel<
  VisibleMailMessage,
  VerificationCodeDto
>;

export type AvatarEditorState = {
  sender: string;
  left: number;
  top: number;
};
