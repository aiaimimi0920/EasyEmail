export type EasyEmailMailAccountScope = "normal" | "agent" | "system";
export type EasyEmailMailAccountKind = "normal_long_lived" | "normal_upgraded_temp" | "anonymous_virtual" | "agent_owned";
export type EasyEmailMailAccountCreatableKind = "normal_long_lived" | "agent_owned";
export type EasyEmailMailAccountImapSecurity = "tls" | "starttls";
export type EasyEmailMailAccountImapProfile = {
  protocol: "imap";
  host: string;
  port: number;
  security: EasyEmailMailAccountImapSecurity;
  username: string;
};
export type EasyEmailMailAccountImapProfileInput = {
  host: string;
  port: number;
  security: EasyEmailMailAccountImapSecurity | "ssl";
  username: string;
};
export type EasyEmailMailAccountStatus = "ready" | "configuring" | "syncing" | "degraded" | "disabled" | "history_only" | "deleted";
export type EasyEmailMailAccountAuthStatus = "not_required" | "valid" | "expired" | "invalid" | "missing" | "refreshing" | "reauthorization_required";
export type EasyEmailMailAccountReceiveStatus = "enabled" | "syncing" | "backoff" | "auth_failed" | "provider_unavailable" | "expired" | "disabled" | "unsupported";
export type EasyEmailMailAccountSendStatus = "enabled" | "sending" | "queued_only" | "auth_failed" | "smtp_unavailable" | "rate_limited" | "disabled" | "unsupported";
export type EasyEmailMailAccount = {
  id: string;
  scope: EasyEmailMailAccountScope;
  kind: EasyEmailMailAccountKind;
  displayName: string;
  primaryAddress?: string;
  providerLabel?: string;
  imap?: EasyEmailMailAccountImapProfile;
  status: EasyEmailMailAccountStatus;
  authStatus: EasyEmailMailAccountAuthStatus;
  receiveStatus: EasyEmailMailAccountReceiveStatus;
  sendStatus: EasyEmailMailAccountSendStatus;
  listedInAllAccounts: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  credentialRefs: Array<{
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
  }>;
};
export type EasyEmailMailAccountListQuery = { scope?: EasyEmailMailAccountScope; limit?: number; cursor?: string };
export type EasyEmailMailAccountCreateRequest = {
  scope?: Exclude<EasyEmailMailAccountScope, "system">;
  kind: EasyEmailMailAccountCreatableKind;
  displayName: string;
  primaryAddress: string;
  providerLabel?: string | null;
  imap?: EasyEmailMailAccountImapProfileInput;
  listedInAllAccounts?: boolean;
  credentialRefs?: Array<{
    secretBackend: string;
    secretKey: `ref:v1:${string}`;
    credentialKind: string;
    authMethod: string;
  }>;
};
export type EasyEmailMailAccountUpdateRequest = {
  expectedVersion: number;
  displayName?: string;
  providerLabel?: string | null;
  imap?: EasyEmailMailAccountImapProfileInput | null;
  listedInAllAccounts?: boolean;
};
export type EasyEmailMailAccountsResponse = { accounts: EasyEmailMailAccount[]; nextCursor?: string };
export type EasyEmailMailAccountResponse = { account: EasyEmailMailAccount };
export type EasyEmailMailAccountImapTestRequest = { accountId: string; credentialRefId: string };
export type EasyEmailMailAccountImapTestResponse = {
  result: { authenticated: true; capabilitySummary: string };
};

export type EasyEmailMailTaxonomyKind = "folder" | "label";

export type EasyEmailMailTaxonomyItem = {
  id: string;
  kind: EasyEmailMailTaxonomyKind;
  name: string;
  parentId?: string;
  color: string;
  sortOrder: number;
  system: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type EasyEmailMailTaxonomyCapabilities = {
  messageReferencePropagation: boolean;
};

export type EasyEmailMailTaxonomyListQuery = {
  kind: EasyEmailMailTaxonomyKind;
  limit?: number;
  cursor?: string;
};

export type EasyEmailMailTaxonomyListResponse = {
  items: EasyEmailMailTaxonomyItem[];
  nextCursor?: string;
  capabilities: EasyEmailMailTaxonomyCapabilities;
};

export type EasyEmailMailTaxonomyUpsertRequest = {
  name: string;
  parentId?: string | null;
  color?: string;
};

export type EasyEmailMailTaxonomyUpdateRequest = EasyEmailMailTaxonomyUpsertRequest & {
  expectedVersion: number;
};

export type EasyEmailMailTaxonomyMutationResponse = {
  item: EasyEmailMailTaxonomyItem;
  capabilities: EasyEmailMailTaxonomyCapabilities;
};

export type EasyEmailMailTaxonomyDeleteResponse = {
  deleted: { id: string; changed: boolean };
  capabilities: EasyEmailMailTaxonomyCapabilities;
};

