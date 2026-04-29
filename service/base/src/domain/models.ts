import type {
  CredentialItemDefinition,
  CredentialSelectionStrategy,
  CredentialSetDefinition,
  CredentialUseCase,
} from "../shared/index.js";

export const CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY = "cloudflare_temp_email" as const;

export type MailProviderTypeKey =
  | "gptmail"
  | "mailtm"
  | "mail2925"
  | "duckmail"
  | "m2u"
  | "moemail"
  | "im215"
  | "guerrillamail"
  | "tempmail-lol"
  | "etempmail"
  | typeof CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY;
export type MailProviderGroupKey = MailProviderTypeKey;
export type MailBusinessStrategyId =
  | "available-first"
  | "gptmail-first"
  | "cloudflare_temp_email-first"
  | "random";
export type MailAliasProviderKey = "ddg" | (string & {});

export type ProviderInstanceStatus = "active" | "cooling" | "provisioning" | "degraded" | "offline";
export type ProviderRuntimeKind = "external" | "cloudflare_temp_email-runtime";
export type CostTier = "free" | "paid";
export type ProvisionMode = "reuse-only" | "auto-create-if-missing" | "always-create-dedicated";
export type BindingMode = "shared-instance" | "dedicated-instance" | "instance-group";
export type StrategyKey = "free-first" | "dynamic-priority" | "random-priority" | "custom-priority";
export type MailboxSessionStatus = "open" | "resolved" | "expired";
export type MessageContentSource = "subject" | "html" | "text";
export type CodeSource = MessageContentSource;
export type ActionLinkSource = MessageContentSource;

export interface ActionLinkCandidate {
  url: string;
  label?: string;
  source: ActionLinkSource;
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
  providerTypeKey: typeof CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY;
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

export interface MailProviderGroupDescriptor {
  key: MailProviderGroupKey;
  displayName: string;
  providerTypeKeys: MailProviderTypeKey[];
  description: string;
}

export interface MailBusinessStrategyDescriptor {
  id: MailBusinessStrategyId;
  displayName: string;
  description: string;
  providerGroupOrder?: MailProviderGroupKey[];
  fallbackProfileId?: string;
  fallbackStrategyKey?: StrategyKey;
}

export interface MailRoutingProfileDescriptor {
  id: string;
  displayName: string;
  description: string;
  providerStrategyModeId?: MailBusinessStrategyId;
  providerSelections?: MailProviderGroupKey[];
  strategyProfileId?: string;
  healthGate?: MailRoutingProfileHealthGate;
}

export interface MailRoutingProfileHealthGate {
  minimumHealthScore?: number;
  maxConsecutiveFailures?: number;
  recentFailureWindowMs?: number;
  recentFailurePenalty?: number;
}

export interface MailStrategyModeResolution {
  service: "mail";
  modeId: MailBusinessStrategyId;
  providerSelections: MailProviderGroupKey[];
  eligibleProviderGroups: MailProviderGroupKey[];
  providerGroupOrder: MailProviderGroupKey[];
  strategyProfileId?: string;
  strategyKey?: StrategyKey;
  warnings: string[];
  explain: string[];
}

export interface ProviderCredentialSet extends CredentialSetDefinition {
  providerTypeKey: MailProviderTypeKey;
  strategy?: CredentialSelectionStrategy;
  groupKeys: string[];
  items: CredentialItemDefinition[];
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCredentialBinding {
  providerInstanceId: string;
  credentialSetId: string;
  useCases?: CredentialUseCase[];
  priority: number;
  updatedAt: string;
}

export interface VerificationMailboxRequest {
  hostId: string;
  providerTypeKey?: MailProviderTypeKey;
  providerRoutingProfileId?: string;
  excludedProviderTypeKeys?: MailProviderTypeKey[];
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
  metadata?: Record<string, string>;
}

export interface MailboxOutcomeReport {
  sessionId: string;
  success: boolean;
  failureReason?: string;
  observedAt?: string;
  registrationMode?: string;
  source?: string;
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
  runtimePlan?: CloudflareTempEmailRuntimePlan;
  strategyMode?: MailStrategyModeResolution;
  aliasOutcome?: MailAliasOutcome;
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

export interface EasyEmailSnapshot {
  providerTypes: ProviderTypeDefinition[];
  runtimeTemplates: RuntimeTemplate[];
  instances: ProviderInstance[];
  bindings: HostBinding[];
  strategies: StrategyProfile[];
  credentialSets: ProviderCredentialSet[];
  credentialBindings: ProviderCredentialBinding[];
  sessions: MailboxSession[];
  messages: ObservedMessage[];
}

export interface EasyEmailCatalog {
  providerTypes: ProviderTypeDefinition[];
  runtimeTemplates: RuntimeTemplate[];
  strategyProfiles: StrategyProfile[];
  providerGroups: MailProviderGroupDescriptor[];
  businessStrategies: MailBusinessStrategyDescriptor[];
  routingProfiles: MailRoutingProfileDescriptor[];
  defaultStrategyModeId?: MailBusinessStrategyId;
  defaultStrategyMode?: MailStrategyModeResolution;
  supportsStrategyMode: boolean;
}

export interface MailboxPlanResult {
  request: VerificationMailboxRequest;
  providerType: ProviderTypeDefinition;
  instance: ProviderInstance;
  binding: HostBinding;
  strategyProfile?: StrategyProfile;
  reusedExistingBinding: boolean;
  requiresProvisioning: boolean;
  runtimePlan?: CloudflareTempEmailRuntimePlan;
  strategyMode?: MailStrategyModeResolution;
  aliasPlan?: MailAliasPlan;
}

export interface BindingResolution {
  binding: HostBinding;
  reusedExistingBinding: boolean;
}

export interface ProviderHealthProbeResult {
  instanceId: string;
  providerTypeKey: MailProviderTypeKey;
  ok: boolean;
  status: ProviderInstanceStatus;
  healthScore: number;
  averageLatencyMs: number;
  checkedAt: string;
  detail?: string;
}

export interface RegisterCloudflareTempEmailRuntimeRequest {
  instanceId?: string;
  templateId?: string;
  displayName?: string;
  baseUrl: string;
  customAuth?: string;
  adminAuth?: string;
  domain?: string;
  domains?: string[];
  randomSubdomainDomains?: string[];
  deploymentTarget?: string;
  shared?: boolean;
  groupKeys?: string[];
  connectionRef?: string;
  connectorKind?: string;
}

export interface RegisterCloudflareTempEmailRuntimeResult {
  instance: ProviderInstance;
  health: ProviderHealthProbeResult;
  runtimePlan: CloudflareTempEmailRuntimePlan;
  created: boolean;
}

export interface ProviderInstanceQueryFilters {
  providerTypeKey?: MailProviderTypeKey;
  status?: ProviderInstanceStatus;
  shared?: boolean;
  groupKey?: string;
  limit?: number;
}

export interface HostBindingQueryFilters {
  hostId?: string;
  providerTypeKey?: MailProviderTypeKey;
  instanceId?: string;
  limit?: number;
}

export interface MailboxSessionQueryFilters {
  hostId?: string;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  status?: MailboxSessionStatus;
  limit?: number;
  newestFirst?: boolean;
}

export interface ObservedMessageQueryFilters {
  sessionId?: string;
  providerInstanceId?: string;
  extractedCodeOnly?: boolean;
  sync?: boolean;
  limit?: number;
  newestFirst?: boolean;
}

export interface MailPersistenceStats {
  providerInstanceCount: number;
  hostBindingCount: number;
  credentialSetCount: number;
  credentialBindingCount: number;
  mailboxSessionCount: number;
  observedMessageCount: number;
  resolvedSessionCount: number;
  extractedCodeMessageCount: number;
}

export function isCloudflareTempEmailProviderKey(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY;
}

export function normalizeMailProviderTypeKey(value: string | undefined): MailProviderTypeKey | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (
    normalized === CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY
    || normalized === "gptmail"
    || normalized === "mailtm"
    || normalized === "mail2925"
    || normalized === "duckmail"
    || normalized === "m2u"
    || normalized === "moemail"
    || normalized === "im215"
    || normalized === "guerrillamail"
    || normalized === "tempmail-lol"
    || normalized === "etempmail"
  ) {
    return normalized as MailProviderTypeKey;
  }

  return undefined;
}
