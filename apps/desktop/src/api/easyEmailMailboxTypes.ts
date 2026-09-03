import type {
  EasyEmailAuthenticationLinkResult,
  EasyEmailCreatedByProvider,
  EasyEmailMailboxSession,
  EasyEmailMailboxSessionStatus,
  EasyEmailObservedMessage,
  EasyEmailProviderInstance,
  EasyEmailRecoveryRequiredFields,
  EasyEmailTemporaryAuthCredential,
  EasyEmailVerificationCodeResult,
  EasyEmailVerificationMailboxOpenResult,
} from "./easyEmailCoreTypes.ts";

export type EasyEmailPlanMailboxResponse<TResult = unknown> = {
  plan: TResult;
};

export type EasyEmailOpenMailboxResponse<
  TResult = EasyEmailVerificationMailboxOpenResult,
> = {
  result: TResult;
};

export type EasyEmailMailboxSessionsResponse<
  TSession = EasyEmailMailboxSession,
> = {
  sessions: TSession[];
};

export type EasyEmailProviderInstancesResponse<
  TInstance = EasyEmailProviderInstance,
> = {
  instances: TInstance[];
};

export type EasyEmailObservedMessagesResponse<
  TMessage = EasyEmailObservedMessage,
> = {
  messages: TMessage[];
};

export type EasyEmailObservedMessageResponse<
  TMessage = EasyEmailObservedMessage,
> = {
  message?: TMessage;
};

export type EasyEmailVerificationCodeResponse<
  TResult = EasyEmailVerificationCodeResult,
> = {
  code?: TResult;
};

export type EasyEmailAuthenticationLinkResponse<
  TResult = EasyEmailAuthenticationLinkResult,
> = {
  authLink?: TResult;
};

export type EasyEmailMailboxRefreshFailure = {
  sessionId: string;
  errorCode: string;
};

export type EasyEmailMailboxRefreshResult = {
  fetchedCount: number;
  insertedCount: number;
  skippedCount: number;
  failedCount: number;
  refreshedSessionIds: string[];
  skippedSessionIds: string[];
  failures: EasyEmailMailboxRefreshFailure[];
};

export type EasyEmailMailboxRefreshResponse = {
  refresh: EasyEmailMailboxRefreshResult;
};

export type EasyEmailReleaseMailboxResult = {
  session: EasyEmailMailboxSession;
  providerInstanceId: string;
  providerTypeKey: string;
  released: boolean;
  detail?: string;
};

export type EasyEmailReleaseMailboxResponse<
  TResult = EasyEmailReleaseMailboxResult,
> = {
  result: TResult;
};

export type EasyEmailUpdateMailboxResponse<
  TSession = EasyEmailMailboxSession,
> = {
  session: TSession;
};

export type EasyEmailMailboxSendResult = {
  sessionId: string;
  providerTypeKey: string;
  providerInstanceId: string;
  senderEmailAddress: string;
  recipientEmailAddress: string;
  sentAt: string;
  deliveryMode: string;
  detail?: string;
};

export type EasyEmailSendMailboxResponse<
  TResult = EasyEmailMailboxSendResult,
> = {
  result: TResult;
};

export type EasyEmailRecoverMailboxResult = {
  recovered: boolean;
  strategy:
    | "account_restore"
    | "session_restore"
    | "recreate_same_address"
    | "not_supported";
  session?: EasyEmailMailboxSession;
  providerTypeKey?: string;
  providerInstanceId?: string;
  detail?: string;
  temporaryAuthCredential?: EasyEmailTemporaryAuthCredential;
  recoveryDataCredential?: Record<string, string>;
  recoverabilityLevel?: "unrecoverable" | "key_recoverable" | "recoverable";
  recoveryRequiredFields?: EasyEmailRecoveryRequiredFields;
  createdByProvider?: EasyEmailCreatedByProvider;
};

export type EasyEmailRecoverMailboxResponse<
  TResult = EasyEmailRecoverMailboxResult,
> = {
  result: TResult;
};

export type EasyEmailMailboxOutcomeResult = {
  session: EasyEmailMailboxSession;
  instance: EasyEmailProviderInstance;
  providerTypeKey: string;
  providerInstanceId: string;
  healthScore: number;
  selectedDomain?: string;
};

export type EasyEmailReportMailboxOutcomeResponse<
  TResult = EasyEmailMailboxOutcomeResult,
> = {
  result: TResult;
};

export type EasyEmailOpenMailboxRequest = {
  hostId: string;
  provisionMode: "reuse-only" | "auto-create-if-missing" | "always-create-dedicated";
  bindingMode: "shared-instance" | "dedicated-instance" | "instance-group";
  providerTypeKey?: string;
  providerRoutingProfileId?: string;
  excludedProviderTypeKeys?: string[];
  excludedDomains?: string[];
  excludedEmailAddresses?: string[];
  requestedDomain?: string;
  requestedLocalPart?: string;
  turnstileToken?: string;
  requestRandomSubdomain?: boolean;
  includeAliasEmail?: boolean;
  strategyProfileId?: string;
  providerStrategyModeId?: string;
  providerGroupSelections?: string[];
  preferredInstanceId?: string;
  runtimeTemplateId?: string;
  groupKey?: string;
  ttlMinutes?: number;
  recoverabilityLevels?: Array<"unrecoverable" | "key_recoverable" | "recoverable">;
  includeUndeterminedRecoverability?: boolean;
  metadata?: Record<string, string>;
};

export type EasyEmailMailboxSessionQuery = {
  hostId?: string;
  providerTypeKey?: string;
  providerInstanceId?: string;
  status?: EasyEmailMailboxSessionStatus;
  limit?: number;
  newestFirst?: boolean;
  [key: string]: string | number | boolean | null | undefined;
};

export type EasyEmailProviderInstanceQuery = {
  providerTypeKey?: string;
  status?: EasyEmailProviderInstance["status"];
  shared?: boolean;
  groupKey?: string;
  limit?: number;
  [key: string]: string | number | boolean | null | undefined;
};

export type EasyEmailObservedMessageQuery = {
  sessionId?: string;
  providerInstanceId?: string;
  extractedCodeOnly?: boolean;
  sync?: boolean;
  newestFirst?: boolean;
  limit?: number;
  [key: string]: string | number | boolean | null | undefined;
};

export type EasyEmailMailboxUpdateRequest = {
  sessionId: string;
  fromContains?: string;
  metadata?: Record<string, string>;
};

export type EasyEmailMailboxSendRequest = {
  sessionId: string;
  toEmailAddress: string;
  toName?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  fromName?: string;
};

export type EasyEmailRecoverMailboxRequest = {
  emailAddress?: string;
  providerTypeKey?: string;
  providerInstanceId?: string;
  hostId?: string;
  recoveryDataCredential?: Record<string, string>;
  recoveryFields?: Record<string, string>;
};

export type EasyEmailMailboxOutcomeRequest = {
  sessionId: string;
  success: boolean;
  failureReason?: string;
  observedAt?: string;
  registrationMode?: string;
  source?: string;
  businessFlow?: string;
  retryLayer?: "step" | "chain" | "attempt";
  attribution?: {
    strength?: "strong" | "weak" | "none";
    kind?: "mailbox_domain_risk" | "provider_route" | "unknown";
    providerTypeKey?: string;
    domain?: string;
    emailAddress?: string;
  };
  policy?: {
    avoidInCurrentAttempt?: boolean;
    globalBlacklist?: boolean;
    cooldownSeconds?: number;
  };
};
