import type {
  HostBinding,
  MailboxCreatedByProvider,
  MailboxRecoveryRequiredFields,
  MailboxTemporaryAuthCredential,
  MailStrategyModeResolution,
  ProviderInstance,
} from "./provider-models.js";
import type {
  ActionLinkSource,
  BindingMode,
  CodeSource,
  MailAliasProviderKey,
  MailBusinessStrategyId,
  MailboxRecoverabilityLevel,
  MailboxSessionStatus,
  MailProviderGroupKey,
  MailProviderTypeKey,
  ProvisionMode,
} from "./provider-taxonomy.js";

export interface ActionLinkCandidate {
  url: string;
  label?: string;
  source: ActionLinkSource;
}

export interface VerificationMailboxRequest {
  hostId: string;
  providerTypeKey?: MailProviderTypeKey;
  providerRoutingProfileId?: string;
  excludedProviderTypeKeys?: MailProviderTypeKey[];
  excludedDomains?: string[];
  excludedEmailAddresses?: string[];
  avoid?: {
    providerTypeKeys?: MailProviderTypeKey[];
    domains?: string[];
    emailAddresses?: string[];
    reason?: string;
    scope?: "attempt";
  };
  provisionMode: ProvisionMode;
  bindingMode: BindingMode;
  requestedDomain?: string;
  requestedLocalPart?: string;
  turnstileToken?: string;
  requestRandomSubdomain?: boolean;
  includeAliasEmail?: boolean;
  strategyProfileId?: string;
  providerStrategyModeId?: MailBusinessStrategyId;
  providerGroupSelections?: MailProviderGroupKey[];
  preferredInstanceId?: string;
  runtimeTemplateId?: string;
  groupKey?: string;
  ttlMinutes?: number;
  recoverabilityLevels?: MailboxRecoverabilityLevel[];
  includeUndeterminedRecoverability?: boolean;
  metadata?: Record<string, string>;
}

export interface MailboxOutcomeReport {
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
}

export interface MailboxOutcomeReportResult {
  session: MailboxSession;
  instance: ProviderInstance;
  providerTypeKey: MailProviderTypeKey;
  providerInstanceId: string;
  healthScore: number;
  selectedDomain?: string;
}

export interface MailboxSession {
  id: string;
  hostId: string;
  providerTypeKey: MailProviderTypeKey;
  providerInstanceId: string;
  emailAddress: string;
  mailboxRef: string;
  status: MailboxSessionStatus;
  createdAt: string;
  expiresAt?: string;
  metadata: Record<string, string>;
}

export interface ObservedMessage {
  id: string;
  sessionId: string;
  providerInstanceId: string;
  observedAt: string;
  sender?: string;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
  extractedCode?: string;
  extractedCandidates?: string[];
  codeSource?: CodeSource;
  actionLinks?: ActionLinkCandidate[];
}

export interface VerificationCodeResult {
  sessionId: string;
  providerInstanceId: string;
  code: string;
  source: CodeSource;
  observedMessageId: string;
  receivedAt: string;
  candidates?: string[];
}

export interface MailboxSendRequest {
  sessionId: string;
  toEmailAddress: string;
  toName?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  fromName?: string;
}

export interface MailboxSendResult {
  sessionId: string;
  providerTypeKey: MailProviderTypeKey;
  providerInstanceId: string;
  senderEmailAddress: string;
  recipientEmailAddress: string;
  sentAt: string;
  deliveryMode: string;
  detail?: string;
}

export interface MailboxSessionUpdateRequest {
  sessionId: string;
  fromContains?: string;
  metadata?: Record<string, string>;
}

export interface AuthenticationLinkResult {
  sessionId: string;
  providerInstanceId: string;
  url: string;
  label?: string;
  source: ActionLinkSource;
  observedMessageId: string;
  receivedAt: string;
  links?: ActionLinkCandidate[];
}

export interface MailAliasInfo {
  providerKey: MailAliasProviderKey;
  emailAddress: string;
  createdAt: string;
}

export type MailAliasPlanStatus = "not_requested" | "skipped_disabled" | "will_create" | "failed";

export interface MailAliasPlan {
  requested: boolean;
  status: MailAliasPlanStatus;
  providerKey?: MailAliasProviderKey;
  failureReason?: string;
  failureMessage?: string;
}

export type MailAliasOutcomeStatus = "not_requested" | "skipped_disabled" | "created" | "failed";

export interface MailAliasOutcome {
  requested: boolean;
  status: MailAliasOutcomeStatus;
  providerKey?: MailAliasProviderKey;
  alias?: MailAliasInfo;
  failureReason?: string;
  failureMessage?: string;
}

export interface CloudflareTempEmailRuntimePlan {
  instanceId: string;
  templateId: string;
  roleKey: string;
  deploymentMode: "shared" | "dedicated";
  config: Record<string, string>;
}

export interface VerificationMailboxOpenResult {
  session: MailboxSession;
  instance: ProviderInstance;
  binding: HostBinding;
  temporaryAuthCredential: MailboxTemporaryAuthCredential;
  recoveryDataCredential: Record<string, string>;
  recoverabilityLevel: MailboxRecoverabilityLevel;
  recoveryRequiredFields: MailboxRecoveryRequiredFields;
  createdByProvider: MailboxCreatedByProvider;
  runtimePlan?: CloudflareTempEmailRuntimePlan;
  strategyMode?: MailStrategyModeResolution;
  aliasOutcome?: MailAliasOutcome;
}
