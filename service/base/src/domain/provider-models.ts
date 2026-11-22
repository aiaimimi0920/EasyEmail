import type {
  CredentialItemDefinition,
  CredentialSelectionStrategy,
  CredentialSetDefinition,
  CredentialUseCase,
} from "../shared/index.js";
import {
  CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY,
  type BindingMode,
  type CostTier,
  type MailBusinessStrategyId,
  type MailboxRecoverabilityEvidenceStatus,
  type MailboxRecoverabilityLevel,
  type MailProviderGroupKey,
  type MailProviderTypeKey,
  type ProviderInstanceStatus,
  type ProviderRuntimeKind,
  type StrategyKey,
} from "./provider-taxonomy.js";

export interface ProviderTypeDefinition {
  key: MailProviderTypeKey;
  displayName: string;
  description: string;
  supportsDynamicProvisioning: boolean;
  defaultStrategyKey: StrategyKey;
  tags: string[];
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

export interface MailboxCreatedByProvider {
  providerTypeKey: MailProviderTypeKey;
  providerInstanceId: string;
  displayName: string;
}

export interface MailboxAccessDescriptor {
  temporaryAuthCredential: MailboxTemporaryAuthCredential;
  recoveryDataCredential: Record<string, string>;
  recoverabilityLevel: MailboxRecoverabilityLevel;
  recoveryRequiredFields: MailboxRecoveryRequiredFields;
  createdByProvider: MailboxCreatedByProvider;
}

export interface MailProviderRecoverabilityProfile {
  providerTypeKey: MailProviderTypeKey;
  providerInstanceId: string;
  recoverabilityLevel: MailboxRecoverabilityLevel;
  evidenceStatus: MailboxRecoverabilityEvidenceStatus;
  minimumHorizonDays: number;
  reason: string;
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
