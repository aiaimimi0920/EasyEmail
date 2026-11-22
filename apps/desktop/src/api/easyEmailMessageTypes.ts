import type { EasyEmailCodeSource } from "./easyEmailCoreTypes.ts";
import type { EasyEmailMailboxRefreshResult } from "./easyEmailMailboxTypes.ts";

export type EasyEmailMailMessageSourceKind =
  | "temporary_session"
  | "imap"
  | "smtp"
  | "local_draft"
  | "agent";

export type EasyEmailMailMessageClassification =
  | "general"
  | "verification"
  | "newsletter"
  | "outgoing"
  | "agent";

export type EasyEmailMailMessageLifecycleState =
  | "active"
  | "expired"
  | "released"
  | "history_only"
  | "draft"
  | "ready";

export type EasyEmailMailMessageListScope =
  | "all"
  | "anonymous"
  | "normal_account"
  | "promoted_account"
  | "agent_account";

export type EasyEmailMailMessageDetailScope = "normal" | "agent" | "all";
export type EasyEmailMailMessageFlagName = "read" | "starred" | "archived" | "important";
export type EasyEmailMailVerificationAccountScope = "anonymous" | "normal" | "promoted" | "agent";

export type EasyEmailMailMessageSummary = {
  id: string;
  accountId?: string;
  sessionId?: string;
  sourceRefId: string;
  sourceKind: EasyEmailMailMessageSourceKind;
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
  classification: EasyEmailMailMessageClassification;
  lifecycleState: EasyEmailMailMessageLifecycleState;
  observedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isImportant: boolean;
  localFolder: string;
  labels: string[];
  version: number;
};

export type EasyEmailMailMessageDetail = EasyEmailMailMessageSummary & {
  bodyText?: string;
  bodyHtml?: string;
  rawBodyHtml?: string;
  rawHtmlAvailable: boolean;
  bodyCacheState: "none" | "cached";
  draftCcAddresses: string[];
  draftBccAddresses: string[];
};

export type EasyEmailMailMessageListQuery = {
  scope?: EasyEmailMailMessageListScope;
  accountId?: string;
  sessionId?: string;
  folder?: string;
  label?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
};

export type EasyEmailMailMessagesResponse = {
  messages: EasyEmailMailMessageSummary[];
  nextCursor?: string;
};

export type EasyEmailMailMessageDetailQuery = {
  scope?: EasyEmailMailMessageDetailScope;
  includeRawHtml?: boolean;
};

export type EasyEmailMailMessageDetailResponse = {
  message: EasyEmailMailMessageDetail;
};

export type EasyEmailMailDraftSaveRequest = {
  draftId?: string | null;
  accountId: string;
  targetAddress?: string;
  ccAddresses?: string[];
  bccAddresses?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
};

export type EasyEmailMailDraftSaveResponse = {
  draft: {
    messageId: string;
    accountId: string;
    savedAt: string;
    version: number;
  };
};

export type EasyEmailMailMessageLocalActionResult = {
  messageId: string;
  changed: boolean;
  status: string;
  remoteApplied: boolean;
};

export type EasyEmailMailMessageLocalActionResponse = {
  action: EasyEmailMailMessageLocalActionResult;
};

export type EasyEmailMailMessageSetFlagRequest = {
  flagName: EasyEmailMailMessageFlagName;
  enabled: boolean;
};

export type EasyEmailMailMessageSetFolderRequest = {
  folderName: string;
};

export type EasyEmailMailMessageSetLabelRequest = {
  labelName: string;
  enabled: boolean;
};

export type EasyEmailMailTrashEmptyRequest = {
  messageIds?: string[];
};

export type EasyEmailMailTrashEmptyResponse = {
  result: {
    requestedCount: number;
    changedCount: number;
    remoteAppliedCount: number;
  };
};

export type EasyEmailMailVerificationRecord = {
  id: string;
  messageId: string;
  sessionId?: string;
  sourceRefId: string;
  accountScope: EasyEmailMailVerificationAccountScope;
  receivedAddress: string;
  code: string;
  codeSource: EasyEmailCodeSource;
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
};

export type EasyEmailMailVerificationListQuery = {
  sessionId?: string;
  scope?: EasyEmailMailVerificationAccountScope | "all";
  freshOnly?: boolean;
  limit?: number;
};

export type EasyEmailMailVerificationsResponse = {
  verifications: EasyEmailMailVerificationRecord[];
};

export type EasyEmailMailReclassifyVerificationResponse = {
  verification?: EasyEmailMailVerificationRecord;
};

export type EasyEmailMailPollVerificationResponse = {
  refresh: EasyEmailMailboxRefreshResult;
  detectedCode?: EasyEmailMailVerificationRecord;
};
