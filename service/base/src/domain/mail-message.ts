import type { CodeSource } from "./models.js";

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
  lifecycleState: MailMessageLifecycleState;
  observedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isImportant: boolean;
  localFolder: string;
  labels: string[];
  newsletterSubscriptionId?: string;
  version: number;
}

export interface MailMessageDetail {
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
  bodyText?: string;
  bodyHtml?: string;
  rawBodyHtml?: string;
  rawHtmlAvailable: boolean;
  bodyCacheState: "none" | "cached";
  hasAttachments: boolean;
  classification: MailMessageClassification;
  lifecycleState: MailMessageLifecycleState;
  observedAt: string;
  draftCcAddresses: string[];
  draftBccAddresses: string[];
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isImportant: boolean;
  localFolder: string;
  labels: string[];
  newsletterSubscriptionId?: string;
  version: number;
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

export interface MailMessageListPosition {
  observedAt: string;
  id: string;
}

export interface MailMessageListResult {
  messages: MailMessageSummary[];
  nextCursor?: string;
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
  codeSource: CodeSource;
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

export interface MailMessageIngestInput {
  messageId?: string;
  rfcMessageId?: string;
  threadKey?: string;
  sourceKind: MailMessageSourceKind;
  sourceRefId: string;
  accountId?: string;
  sessionId?: string;
  providerInstanceId?: string;
  externalMessageId?: string;
  receivedAddress: string;
  providerLabel: string;
  lifecycleState: MailMessageLifecycleState;
  subject: string;
  fromAddress: string;
  fromName?: string;
  snippet: string;
  bodyText?: string;
  bodyHtml?: string;
  hasAttachments?: boolean;
  classification?: MailMessageClassification;
  newsletterListId?: string;
  newsletterUnsubscribeMethods?: string[];
  observedAt: string;
  now: string;
}

export interface MailMessageIngestResult {
  messageId: string;
  insertedMessage: boolean;
  insertedSource: boolean;
  deleted: boolean;
}

export interface MailMessageRepositoryListQuery {
  scope: MailMessageListScope;
  accountId?: string;
  sessionId?: string;
  folder?: string;
  label?: string;
  search?: string;
  includeArchived: boolean;
  limit: number;
  after?: MailMessageListPosition;
}

export interface MailMessageRepositoryListResult {
  messages: MailMessageSummary[];
  hasMore: boolean;
}

export interface MailDraftRepositoryUpsertInput {
  draftId?: string;
  accountId: string;
  fromAddress: string;
  fromName?: string;
  providerLabel: string;
  targetAddress: string;
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml?: string;
  now: string;
}

export interface StoredMessageVerificationSource {
  messageId: string;
  accountScope: MailVerificationAccountScope;
  sessionId?: string;
  sourceRefId: string;
  receivedAddress: string;
  subject: string;
  fromAddress: string;
  snippet: string;
  bodyText?: string;
  bodyHtml?: string;
  observedAt: string;
  classification: MailMessageClassification;
}

export interface MailVerificationUpsertInput {
  id: string;
  messageId: string;
  sessionId?: string;
  sourceRefId: string;
  accountScope: MailVerificationAccountScope;
  receivedAddress: string;
  code: string;
  codeSource: CodeSource;
  candidates: string[];
  issuerHint?: string;
  targetServiceHint?: string;
  confidence: number;
  expiresAt?: string;
  extractedAt: string;
}

export interface MailMessageRepository {
  ingestMailMessage(input: MailMessageIngestInput): Promise<MailMessageIngestResult>;
  listMailMessages(query: MailMessageRepositoryListQuery): Promise<MailMessageRepositoryListResult>;
  getMailMessageDetail(
    id: string,
    scope?: MailMessageDetailScope,
  ): Promise<{ detail: MailMessageDetail; rawBodyHtml?: string } | undefined>;
  upsertLocalDraft(input: MailDraftRepositoryUpsertInput): Promise<MailDraftSaveResult>;
  deleteLocalDraft(id: string, now: string): Promise<boolean>;
  setMailMessageLocalFlag(
    id: string,
    flagName: MailMessageFlagName,
    enabled: boolean,
    now: string,
  ): Promise<boolean | undefined>;
  setMailMessageLocalFolder(
    id: string,
    folderName: string,
    now: string,
  ): Promise<boolean | undefined>;
  setMailMessageLocalLabel(
    id: string,
    labelName: string,
    enabled: boolean,
    now: string,
  ): Promise<boolean | undefined>;
  softDeleteMailMessage(id: string, now: string): Promise<boolean | undefined>;
  listTrashMessageIds(): Promise<string[]>;
  promoteTemporarySessionMessages(
    sessionId: string,
    targetAccountId: string,
    now: string,
  ): Promise<number>;
  getMessageForVerification(id: string): Promise<StoredMessageVerificationSource | undefined>;
  setMailMessageClassification(
    id: string,
    classification: MailMessageClassification,
    now: string,
  ): Promise<void>;
}

export interface MailVerificationRepository {
  upsertMailVerificationCode(
    input: MailVerificationUpsertInput,
    nowMs: number,
  ): Promise<MailVerificationRecord>;
  deleteMailVerificationCodesForMessage(messageId: string): Promise<number>;
  listMailVerificationCodes(
    query: MailVerificationListQuery,
    nowMs: number,
  ): Promise<MailVerificationRecord[]>;
}
