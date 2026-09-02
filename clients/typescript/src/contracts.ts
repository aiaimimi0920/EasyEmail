export type MailProviderTypeKey =
  | "cloudflare_temp_email"
  | "duckmail"
  | "etempmail"
  | "gptmail"
  | "guerrillamail"
  | "im215"
  | "m2u"
  | "mail2925"
  | "mailtm"
  | "moemail"
  | "tempmail-lol"
  | "temporam"
  | (string & {});

export type ProviderInstanceStatus = "active" | "cooling" | "provisioning" | "degraded" | "offline";
export type ProviderRuntimeKind = "external" | "cloudflare_temp_email-runtime" | (string & {});
export type CostTier = "free" | "paid";
export type ProvisionMode = "reuse-only" | "auto-create-if-missing" | "always-create-dedicated";
export type BindingMode = "shared-instance" | "dedicated-instance" | "instance-group";
export type StrategyKey = "free-first" | "dynamic-priority" | "random-priority" | "custom-priority";
export type MailboxSessionStatus = "open" | "resolved" | "expired";
export type MessageContentSource = "subject" | "html" | "text";
export type MailboxRecoverabilityLevel = "unrecoverable" | "key_recoverable" | "recoverable";
export type MailboxRecoverabilityEvidenceStatus = "undetermined" | "verified";
export type MailBusinessStrategyId =
  | "available-first"
  | "gptmail-first"
  | "cloudflare_temp_email-first"
  | "random"
  | (string & {});

export interface Contact {
  id: string;
  displayName: string;
  emailAddress: string;
  note?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContactListQuery {
  limit?: number;
  cursor?: string;
}

export interface ContactListResult {
  contacts: Contact[];
  nextCursor?: string;
}

export interface ContactCreateInput {
  displayName?: string;
  emailAddress: string;
  note?: string | null;
}

export interface ContactUpdateInput {
  expectedVersion: number;
  displayName?: string;
  emailAddress?: string;
  note?: string | null;
}

export type MailAccountScope = "normal" | "agent" | "system";
export type MailAccountKind =
  | "normal_long_lived"
  | "normal_upgraded_temp"
  | "anonymous_virtual"
  | "agent_owned";
export type MailAccountCreatableKind = "normal_long_lived" | "agent_owned";
export type MailAccountStatus = "ready" | "configuring" | "syncing" | "degraded" | "disabled" | "history_only" | "deleted";
export type MailAccountAuthStatus = "not_required" | "valid" | "expired" | "invalid" | "missing" | "refreshing" | "reauthorization_required";
export type MailAccountReceiveStatus = "enabled" | "syncing" | "backoff" | "auth_failed" | "provider_unavailable" | "expired" | "disabled" | "unsupported";
export type MailAccountSendStatus = "enabled" | "sending" | "queued_only" | "auth_failed" | "smtp_unavailable" | "rate_limited" | "disabled" | "unsupported";

export interface MailCredentialRef {
  id: string;
  ownerAccountId: string;
  secretBackend: string;
  secretKey: string;
  credentialKind: string;
  authMethod: string;
  status: "active" | "missing" | "invalid" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
}

export interface MailAccount {
  id: string;
  scope: MailAccountScope;
  kind: MailAccountKind;
  displayName: string;
  primaryAddress?: string;
  providerLabel?: string;
  status: MailAccountStatus;
  authStatus: MailAccountAuthStatus;
  receiveStatus: MailAccountReceiveStatus;
  sendStatus: MailAccountSendStatus;
  listedInAllAccounts: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  credentialRefs: MailCredentialRef[];
}

export interface MailAccountListQuery {
  scope?: MailAccountScope;
  limit?: number;
  cursor?: string;
}

export interface MailAccountListResult {
  accounts: MailAccount[];
  nextCursor?: string;
}

export interface MailAccountCredentialRefInput {
  secretBackend: string;
  secretKey: `ref:v1:${string}`;
  credentialKind: string;
  authMethod: string;
}

export interface MailAccountCreateInput {
  scope?: Exclude<MailAccountScope, "system">;
  kind: MailAccountCreatableKind;
  displayName: string;
  primaryAddress: string;
  providerLabel?: string | null;
  listedInAllAccounts?: boolean;
  credentialRefs?: MailAccountCredentialRefInput[];
}

export interface MailAccountUpdateInput {
  expectedVersion: number;
  displayName?: string;
  providerLabel?: string | null;
  listedInAllAccounts?: boolean;
}

export type MailTaxonomyKind = "folder" | "label";

export interface MailTaxonomyItem {
  id: string;
  kind: MailTaxonomyKind;
  name: string;
  parentId?: string;
  color: string;
  sortOrder: number;
  system: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailTaxonomyCapabilities {
  messageReferencePropagation: boolean;
}

export interface MailTaxonomyListQuery {
  kind: MailTaxonomyKind;
  limit?: number;
  cursor?: string;
}

export interface MailTaxonomyListResult {
  items: MailTaxonomyItem[];
  nextCursor?: string;
  capabilities: MailTaxonomyCapabilities;
}

export interface MailTaxonomyUpsertInput {
  name: string;
  parentId?: string | null;
  color?: string;
}

export interface MailTaxonomyUpdateInput extends MailTaxonomyUpsertInput {
  expectedVersion: number;
}

export interface MailTaxonomyMutationResult {
  item: MailTaxonomyItem;
  capabilities: MailTaxonomyCapabilities;
}

export interface MailTaxonomyDeleteResult {
  deleted: { id: string; changed: boolean };
  capabilities: MailTaxonomyCapabilities;
}

export interface ActionLinkCandidate {
  url: string;
  label?: string;
  source: MessageContentSource;
}

export interface ProviderTypeDefinition {
  key: MailProviderTypeKey;
  displayName: string;
  description: string;
  supportsDynamicProvisioning: boolean;
  defaultStrategyKey: StrategyKey;
  tags: string[];
}

export interface RuntimeTemplate {
  id: string;
  providerTypeKey: MailProviderTypeKey;
  displayName: string;
  description: string;
  roleKey: string;
  sharedByDefault: boolean;
  metadata: Record<string, string>;
}

export interface ProviderInstance {
  id: string;
  providerTypeKey: MailProviderTypeKey;
  displayName: string;
  status: ProviderInstanceStatus;
  runtimeKind: ProviderRuntimeKind;
  connectorKind: string;
  shared: boolean;
  costTier: CostTier;
  healthScore: number;
  averageLatencyMs: number;
  connectionRef: string;
  hostBindings: string[];
  groupKeys: string[];
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface HostBinding {
  hostId: string;
  providerTypeKey: MailProviderTypeKey;
  bindingMode: BindingMode;
  instanceId: string;
  groupKey?: string;
  updatedAt: string;
}

export interface StrategyProfile {
  id: string;
  key: StrategyKey;
  displayName: string;
  description: string;
  preferredInstanceIds?: string[];
  metadata: Record<string, string>;
}

export interface MailProviderRecoverabilityProfile {
  providerTypeKey: MailProviderTypeKey;
  providerInstanceId: string;
  recoverabilityLevel: MailboxRecoverabilityLevel;
  evidenceStatus: MailboxRecoverabilityEvidenceStatus;
  minimumHorizonDays: number;
  reason: string;
}

export interface MailStrategyModeResolution {
  service: "mail";
  modeId: MailBusinessStrategyId;
  providerSelections: MailProviderTypeKey[];
  eligibleProviderGroups: MailProviderTypeKey[];
  providerGroupOrder: MailProviderTypeKey[];
  strategyProfileId?: string;
  strategyKey?: StrategyKey;
  warnings: string[];
  explain: string[];
}

export interface EasyEmailCatalog {
  providerTypes: ProviderTypeDefinition[];
  runtimeTemplates: RuntimeTemplate[];
  strategyProfiles: StrategyProfile[];
  providerRecoverabilityProfiles: MailProviderRecoverabilityProfile[];
  providerGroups: Array<{
    key: MailProviderTypeKey;
    displayName: string;
    providerTypeKeys: MailProviderTypeKey[];
    description: string;
  }>;
  businessStrategies: Array<{
    id: MailBusinessStrategyId;
    displayName: string;
    description: string;
    providerGroupOrder?: MailProviderTypeKey[];
    fallbackProfileId?: string;
    fallbackStrategyKey?: StrategyKey;
  }>;
  routingProfiles: Array<{
    id: string;
    displayName: string;
    description: string;
    providerStrategyModeId?: MailBusinessStrategyId;
    providerSelections?: MailProviderTypeKey[];
    strategyProfileId?: string;
    healthGate?: {
      minimumHealthScore?: number;
      maxConsecutiveFailures?: number;
      recentFailureWindowMs?: number;
      recentFailurePenalty?: number;
    };
  }>;
  defaultStrategyModeId?: MailBusinessStrategyId;
  defaultStrategyMode?: MailStrategyModeResolution;
  supportsStrategyMode: boolean;
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
