import type { MessageContentSource } from "./shared-types.js";

export interface MailboxRefreshFailure {
  sessionId: string;
  errorCode: string;
}

export interface MailboxRefreshResult {
  fetchedCount: number;
  insertedCount: number;
  skippedCount: number;
  failedCount: number;
  refreshedSessionIds: string[];
  skippedSessionIds: string[];
  failures: MailboxRefreshFailure[];
}

export type MailMessageSourceKind =
  | "temporary_session"
  | "imap"
  | "smtp"
  | "local_draft"
  | "agent";

export type MailMessageClassification =
  | "general"
  | "verification"
  | "newsletter"
  | "outgoing"
  | "agent";

export type MailMessageLifecycleState =
  | "active"
  | "expired"
  | "released"
  | "history_only"
  | "draft"
  | "ready";

export type MailMessageListScope =
  | "all"
  | "anonymous"
  | "normal_account"
  | "promoted_account"
  | "agent_account";

export type MailMessageDetailScope = "normal" | "agent" | "all";
export type MailMessageFlagName = "read" | "starred" | "archived" | "important";
export type MailVerificationAccountScope = "anonymous" | "normal" | "promoted" | "agent";

export interface MailMessageSummary {
  id: string;
  accountId?: string;
  sessionId?: string;
  sourceRefId: string;
  sourceKind: MailMessageSourceKind;
  providerInstanceId?: string;
  externalMessageId?: string;
  rfcMessageId?: string;
  threadKey?: string;
  receivedAddress: string;
  providerLabel: string;
  subject: string;
  fromAddress: string;
  fromName?: string;
  snippet: string;
  hasAttachments: boolean;
  classification: MailMessageClassification;
  newsletterSubscriptionId?: string;
  lifecycleState: MailMessageLifecycleState;
  observedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isImportant: boolean;
  localFolder: string;
  labels: string[];
  version: number;
}

export interface MailMessageDetail extends MailMessageSummary {
  bodyText?: string;
  bodyHtml?: string;
  rawBodyHtml?: string;
  rawHtmlAvailable: boolean;
  bodyCacheState: "none" | "cached";
  draftCcAddresses: string[];
  draftBccAddresses: string[];
}

export interface MailMessageListQuery {
  scope?: MailMessageListScope;
  accountId?: string;
  sessionId?: string;
  folder?: string;
  label?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface MailMessageListResult {
  messages: MailMessageSummary[];
  nextCursor?: string;
}

export interface MailMessageDetailQuery {
  scope?: MailMessageDetailScope;
  includeRawHtml?: boolean;
}

export interface MailDraftSaveInput {
  draftId?: string | null;
  accountId: string;
  targetAddress?: string;
  ccAddresses?: string[];
  bccAddresses?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
}

export interface MailDraftSaveResult {
  messageId: string;
  accountId: string;
  savedAt: string;
  version: number;
}

export interface MailMessageSetFlagInput {
  flagName: MailMessageFlagName;
  enabled: boolean;
}

export interface MailMessageSetFolderInput {
  folderName: string;
}

export interface MailMessageSetLabelInput {
  labelName: string;
  enabled: boolean;
}

export interface MailTrashEmptyInput {
  messageIds?: string[];
}

export interface MailMessageLocalActionResult {
  messageId: string;
  changed: boolean;
  status: string;
  remoteApplied: boolean;
}

export interface MailMessageBatchActionResult {
  requestedCount: number;
  changedCount: number;
  remoteAppliedCount: number;
}

export interface MailVerificationRecord {
  id: string;
  messageId: string;
  sessionId?: string;
  sourceRefId: string;
  accountScope: MailVerificationAccountScope;
  receivedAddress: string;
  code: string;
  codeSource: MessageContentSource;
  candidates: string[];
  issuerHint?: string;
  targetServiceHint?: string;
  confidence: number;
  expiresAt?: string;
  isFresh: boolean;
  extractedAt: string;
  subject: string;
  fromAddress: string;
  observedAt: string;
}

export interface MailVerificationListQuery {
  sessionId?: string;
  scope?: MailVerificationAccountScope | "all";
  freshOnly?: boolean;
  limit?: number;
}

export interface PollMailboxVerificationResult {
  refresh: MailboxRefreshResult;
  detectedCode?: MailVerificationRecord;
}
