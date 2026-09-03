export type EasyEmailHttpQuery = Record<
  string,
  string | number | boolean | null | undefined
>;

export type EasyEmailHttpRequest = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: EasyEmailHttpQuery;
  body?: unknown;
  signal?: AbortSignal;
};

export type EasyEmailHttpClientOptions = {
  baseUrl: string;
  bearerToken?: string;
  fetch?: typeof fetch;
};

export type EasyEmailMailboxSessionStatus = "open" | "resolved" | "expired";
export type EasyEmailCodeSource = "subject" | "html" | "text";

export type EasyEmailMailboxSession = {
  id: string;
  hostId: string;
  providerTypeKey: string;
  providerInstanceId: string;
  emailAddress: string;
  mailboxRef: string;
  status: EasyEmailMailboxSessionStatus;
  createdAt: string;
  expiresAt?: string;
  metadata: Record<string, string>;
};

export type EasyEmailProviderInstance = {
  id: string;
  providerTypeKey: string;
  displayName: string;
  status: "active" | "cooling" | "provisioning" | "degraded" | "offline";
  runtimeKind: "external" | "cloudflare_temp_email-runtime";
  connectorKind: string;
  shared: boolean;
  costTier: "free" | "paid";
  healthScore: number;
  averageLatencyMs: number;
  connectionRef: string;
  hostBindings: string[];
  groupKeys: string[];
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type EasyEmailHostBinding = {
  hostId: string;
  providerTypeKey: string;
  bindingMode: "shared-instance" | "dedicated-instance" | "instance-group";
  instanceId: string;
  groupKey?: string;
  updatedAt: string;
};

export type EasyEmailTemporaryAuthCredential = {
  credentialType: string;
  fields: Record<string, string>;
  serverManaged: boolean;
  expiresAt?: string;
};

export type EasyEmailRecoveryRequiredFields = {
  evidenceStatus: "undetermined" | "verified";
  minimumHorizonDays: number;
  reason: string;
  fields: Record<string, string>;
  serverSidePrerequisites: string[];
};

export type EasyEmailCreatedByProvider = {
  providerTypeKey: string;
  providerInstanceId: string;
  displayName: string;
};

export type EasyEmailVerificationMailboxOpenResult = {
  session: EasyEmailMailboxSession;
  instance: EasyEmailProviderInstance;
  binding: EasyEmailHostBinding;
  temporaryAuthCredential: EasyEmailTemporaryAuthCredential;
  recoveryDataCredential: Record<string, string>;
  recoverabilityLevel: "unrecoverable" | "key_recoverable" | "recoverable";
  recoveryRequiredFields: EasyEmailRecoveryRequiredFields;
  createdByProvider: EasyEmailCreatedByProvider;
  runtimePlan?: Record<string, unknown>;
  strategyMode?: Record<string, unknown>;
  aliasOutcome?: Record<string, unknown>;
};

export type EasyEmailActionLinkCandidate = {
  url: string;
  label?: string;
  source: EasyEmailCodeSource;
};

export type EasyEmailObservedMessage = {
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
  codeSource?: EasyEmailCodeSource;
  actionLinks?: EasyEmailActionLinkCandidate[];
};

export type EasyEmailVerificationCodeResult = {
  sessionId: string;
  providerInstanceId: string;
  code: string;
  source: EasyEmailCodeSource;
  observedMessageId: string;
  receivedAt: string;
  candidates?: string[];
};

export type EasyEmailAuthenticationLinkResult = {
  sessionId: string;
  providerInstanceId: string;
  url: string;
  label?: string;
  source: EasyEmailCodeSource;
  observedMessageId: string;
  receivedAt: string;
  links?: EasyEmailActionLinkCandidate[];
};

export type EasyEmailCatalogResponse<TCatalog = unknown> = {
  catalog: TCatalog;
};

export type EasyEmailContact = {
  id: string;
  displayName: string;
  emailAddress: string;
  note?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type EasyEmailContactCreateRequest = {
  displayName?: string;
  emailAddress: string;
  note?: string | null;
};

export type EasyEmailContactUpdateRequest = {
  expectedVersion: number;
  displayName?: string;
  emailAddress?: string;
  note?: string | null;
};

export type EasyEmailContactListQuery = {
  limit?: number;
  cursor?: string;
};

export type EasyEmailContactsResponse<TContact = EasyEmailContact> = {
  contacts: TContact[];
  nextCursor?: string;
};

export type EasyEmailContactResponse<TContact = EasyEmailContact> = {
  contact: TContact;
};

export type EasyEmailContactDeleteResponse = {
  deleted: { id: string };
};

