import type {
  BindingMode,
  MailBusinessStrategyId,
  MailProviderTypeKey,
  MailboxRecoverabilityEvidenceStatus,
  MailboxRecoverabilityLevel,
  MailboxSessionStatus,
  MessageContentSource,
  ProvisionMode,
} from "./shared-types.js";
import type {
  ActionLinkCandidate,
  HostBinding,
  MailProviderRecoverabilityProfile,
  MailStrategyModeResolution,
  ProviderInstance,
  ProviderTypeDefinition,
  RuntimeTemplate,
  StrategyProfile,
} from "./contracts-catalog.js";

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
  providerGroupSelections?: MailProviderTypeKey[];
  preferredInstanceId?: string;
  runtimeTemplateId?: string;
  groupKey?: string;
  ttlMinutes?: number;
  recoverabilityLevels?: MailboxRecoverabilityLevel[];
  includeUndeterminedRecoverability?: boolean;
  metadata?: Record<string, string>;
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

export interface MailboxTemporaryAuthCredential {
  credentialType: string;
  fields: Record<string, string>;
  serverManaged: boolean;
  expiresAt?: string;
}

export interface MailboxRecoveryRequiredFields {
  evidenceStatus: MailboxRecoverabilityEvidenceStatus;
  minimumHorizonDays: number;
  reason: string;
  fields: Record<string, string>;
  serverSidePrerequisites: string[];
}

export interface MailboxAccessDescriptor {
  temporaryAuthCredential: MailboxTemporaryAuthCredential;
  recoveryDataCredential: Record<string, string>;
  recoverabilityLevel: MailboxRecoverabilityLevel;
  recoveryRequiredFields: MailboxRecoveryRequiredFields;
  createdByProvider: {
    providerTypeKey: MailProviderTypeKey;
    providerInstanceId: string;
    displayName: string;
  };
}

export interface MailboxPlanResult {
  request: VerificationMailboxRequest;
  providerType: ProviderTypeDefinition;
  instance: ProviderInstance;
  binding: HostBinding;
  strategyProfile?: StrategyProfile;
  reusedExistingBinding: boolean;
  requiresProvisioning: boolean;
  runtimePlan?: {
    instanceId: string;
    templateId: string;
    roleKey: string;
    deploymentMode: "shared" | "dedicated";
    config: Record<string, string>;
  };
  strategyMode?: MailStrategyModeResolution;
  aliasPlan?: {
    requested: boolean;
    status: "not_requested" | "skipped_disabled" | "will_create" | "failed";
    providerKey?: string;
    failureReason?: string;
    failureMessage?: string;
  };
  recoverabilityProfile: MailProviderRecoverabilityProfile;
}

export interface VerificationMailboxOpenResult extends MailboxAccessDescriptor {
  session: MailboxSession;
  instance: ProviderInstance;
  binding: HostBinding;
  runtimePlan?: MailboxPlanResult["runtimePlan"];
  strategyMode?: MailStrategyModeResolution;
  aliasOutcome?: {
    requested: boolean;
    status: "not_requested" | "skipped_disabled" | "created" | "failed";
    providerKey?: string;
    alias?: {
      providerKey: string;
      emailAddress: string;
      createdAt: string;
    };
    failureReason?: string;
    failureMessage?: string;
  };
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

export interface ReleaseMailboxRequest {
  sessionId: string;
  reason?: string;
}

export interface ReleaseMailboxResult {
  session: MailboxSession;
  providerInstanceId: string;
  providerTypeKey: MailProviderTypeKey;
  released: boolean;
  detail?: string;
}

export interface RecoverMailboxByEmailRequest {
  emailAddress?: string;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  hostId?: string;
  recoveryDataCredential?: Record<string, string>;
  recoveryFields?: Record<string, string>;
}

export interface RecoverMailboxByEmailResult extends Partial<MailboxAccessDescriptor> {
  recovered: boolean;
  strategy: "account_restore" | "session_restore" | "recreate_same_address" | "not_supported";
  session?: MailboxSession;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  detail?: string;
}

export interface RecoverMailboxCapacityRequest {
  failureCode?: string;
  detail?: string;
  providerTypeKey?: string;
  providerInstanceId?: string;
  staleAfterSeconds?: number;
  maxDeleteCount?: number;
  force?: boolean;
}

export interface RecoverMailboxCapacityResult {
  ok: boolean;
  status: string;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  action?: string;
  detail?: string;
  recovery?: unknown;
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
  codeSource?: MessageContentSource;
  actionLinks?: ActionLinkCandidate[];
}

export interface ObserveMessageInput {
  sessionId: string;
  sender?: string;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
  observedAt?: string;
  actionLinks?: ActionLinkCandidate[];
}

export interface ObservedMessageQueryFilters {
  [key: string]: string | number | boolean | undefined;
  sessionId?: string;
  providerInstanceId?: string;
  extractedCodeOnly?: boolean;
  sync?: boolean;
  limit?: number;
  newestFirst?: boolean;
}

export interface VerificationCodeResult {
  sessionId: string;
  providerInstanceId: string;
  code: string;
  source: MessageContentSource;
  observedMessageId: string;
  receivedAt: string;
  candidates?: string[];
}

export interface AuthenticationLinkResult {
  sessionId: string;
  providerInstanceId: string;
  url: string;
  label?: string;
  source: MessageContentSource;
  observedMessageId: string;
  receivedAt: string;
  links?: ActionLinkCandidate[];
}

export interface EasyEmailSnapshot {
  providerTypes: ProviderTypeDefinition[];
  runtimeTemplates: RuntimeTemplate[];
  instances: ProviderInstance[];
  bindings: HostBinding[];
  strategies: StrategyProfile[];
  credentialSets: unknown[];
  credentialBindings: unknown[];
  sessions: MailboxSession[];
  messages: ObservedMessage[];
}
