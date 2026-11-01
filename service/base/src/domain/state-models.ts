import type { CloudflareTempEmailSendTransport } from "./cloudflare-send-policy.js";
import type {
  ActionLinkCandidate,
  CloudflareTempEmailRuntimePlan,
  MailAliasPlan,
  MailboxSession,
  ObservedMessage,
  VerificationMailboxRequest,
} from "./mailbox-models.js";
import type {
  HostBinding,
  MailBusinessStrategyDescriptor,
  MailProviderGroupDescriptor,
  MailProviderRecoverabilityProfile,
  MailRoutingProfileDescriptor,
  MailStrategyModeResolution,
  ProviderCredentialBinding,
  ProviderCredentialSet,
  ProviderInstance,
  ProviderTypeDefinition,
  RuntimeTemplate,
  StrategyProfile,
} from "./provider-models.js";
import type {
  MailBusinessStrategyId,
  MailProviderTypeKey,
  ProviderInstanceStatus,
} from "./provider-taxonomy.js";

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
  providerRecoverabilityProfiles: MailProviderRecoverabilityProfile[];
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
  recoverabilityProfile: MailProviderRecoverabilityProfile;
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
  sendTransport?: CloudflareTempEmailSendTransport;
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
