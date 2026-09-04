import type {
  BindingMode,
  CostTier,
  MailBusinessStrategyId,
  MailProviderTypeKey,
  MailboxRecoverabilityEvidenceStatus,
  MailboxRecoverabilityLevel,
  MessageContentSource,
  ProviderInstanceStatus,
  ProviderRuntimeKind,
  StrategyKey,
} from "./shared-types.js";

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
export type MailAccountImapSecurity = "tls" | "starttls";
export interface MailAccountImapProfile {
  protocol: "imap";
  host: string;
  port: number;
  security: MailAccountImapSecurity;
  username: string;
}
export interface MailAccountImapProfileInput {
  host: string;
  port: number;
  security: MailAccountImapSecurity | "ssl";
  username: string;
}
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
  imap?: MailAccountImapProfile;
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
  imap?: MailAccountImapProfileInput;
  listedInAllAccounts?: boolean;
  credentialRefs?: MailAccountCredentialRefInput[];
}

export interface MailAccountUpdateInput {
  expectedVersion: number;
  displayName?: string;
  providerLabel?: string | null;
  imap?: MailAccountImapProfileInput | null;
  listedInAllAccounts?: boolean;
}

export interface MailAccountImapTestRequest {
  accountId: string;
  credentialRefId: string;
}

export interface MailAccountImapTestResult {
  authenticated: true;
  capabilitySummary: string;
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
