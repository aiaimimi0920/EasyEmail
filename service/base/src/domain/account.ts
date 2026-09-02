export type MailAccountScope = "normal" | "agent" | "system";

export type MailAccountKind =
  | "normal_long_lived"
  | "normal_upgraded_temp"
  | "anonymous_virtual"
  | "agent_owned";

export type MailAccountCreatableKind = "normal_long_lived" | "agent_owned";

export type MailAccountStatus =
  | "ready"
  | "configuring"
  | "syncing"
  | "degraded"
  | "disabled"
  | "history_only"
  | "deleted";

export type MailAccountAuthStatus =
  | "not_required"
  | "valid"
  | "expired"
  | "invalid"
  | "missing"
  | "refreshing"
  | "reauthorization_required";

export type MailAccountReceiveStatus =
  | "enabled"
  | "syncing"
  | "backoff"
  | "auth_failed"
  | "provider_unavailable"
  | "expired"
  | "disabled"
  | "unsupported";

export type MailAccountSendStatus =
  | "enabled"
  | "sending"
  | "queued_only"
  | "auth_failed"
  | "smtp_unavailable"
  | "rate_limited"
  | "disabled"
  | "unsupported";

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

export interface MailCredentialRefInput {
  secretBackend: string;
  secretKey: `ref:v1:${string}`;
  credentialKind: string;
  authMethod: string;
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

export interface MailAccountCreateInput {
  scope?: Exclude<MailAccountScope, "system">;
  kind: MailAccountCreatableKind;
  displayName: string;
  primaryAddress: string;
  providerLabel?: string | null;
  listedInAllAccounts?: boolean;
  credentialRefs?: MailCredentialRefInput[];
}

export interface MailAccountUpdateInput {
  expectedVersion: number;
  displayName?: string;
  providerLabel?: string | null;
  listedInAllAccounts?: boolean;
}

export interface MailAccountDeleteInput {
  expectedVersion: number;
}

export interface MailAccountListPosition {
  filterScope: MailAccountScope | "all";
  createdAt: string;
  id: string;
}

export interface MailAccountRepositoryListQuery {
  scope?: MailAccountScope;
  limit: number;
  after?: MailAccountListPosition;
}

export interface MailAccountRepositoryListResult {
  accounts: MailAccount[];
  hasMore: boolean;
}

export interface MailAccountRepositoryCreateInput {
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
  credentialRefs: MailCredentialRefInput[];
  now: string;
}

export interface MailAccountRepositoryUpdateInput {
  id: string;
  expectedVersion: number;
  displayName: string;
  providerLabel?: string;
  listedInAllAccounts: boolean;
  now: string;
}

export interface MailAccountRepository {
  listMailAccounts(query: MailAccountRepositoryListQuery): Promise<MailAccountRepositoryListResult>;
  getMailAccount(id: string): Promise<MailAccount | undefined>;
  createMailAccount(input: MailAccountRepositoryCreateInput): Promise<MailAccount>;
  updateMailAccount(input: MailAccountRepositoryUpdateInput): Promise<MailAccount | undefined>;
  disableMailAccount(id: string, expectedVersion: number, now: string): Promise<MailAccount | undefined>;
  deleteMailAccount(id: string, expectedVersion: number, now: string): Promise<boolean>;
}
