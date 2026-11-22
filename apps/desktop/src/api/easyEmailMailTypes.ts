import type { EasyEmailMailboxSession } from "./easyEmailCoreTypes.ts";

export type EasyEmailMailAccountScope = "normal" | "agent" | "system";
export type EasyEmailMailAccountKind = "normal_long_lived" | "normal_upgraded_temp" | "anonymous_virtual" | "agent_owned";
export type EasyEmailMailAccountCreatableKind = "normal_long_lived" | "agent_owned";
export type EasyEmailMailAccountImapSecurity = "tls" | "starttls";
export type EasyEmailMailAccountSmtpSecurity = "tls" | "starttls";
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
export type EasyEmailMailAccountSmtpProfile = {
  protocol: "smtp";
  host: string;
  port: number;
  security: EasyEmailMailAccountSmtpSecurity;
  username: string;
};
export type EasyEmailMailAccountSmtpProfileInput = {
  host: string;
  port: number;
  security: EasyEmailMailAccountSmtpSecurity | "ssl";
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
  smtp?: EasyEmailMailAccountSmtpProfile;
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
  smtp?: EasyEmailMailAccountSmtpProfileInput;
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
  smtp?: EasyEmailMailAccountSmtpProfileInput | null;
  listedInAllAccounts?: boolean;
};
export type EasyEmailMailAccountsResponse = { accounts: EasyEmailMailAccount[]; nextCursor?: string };
export type EasyEmailMailAccountResponse = { account: EasyEmailMailAccount };
export type EasyEmailMailAccountImapTestRequest = { accountId: string; credentialRefId: string };
export type EasyEmailMailAccountImapTestResponse = {
  result: { authenticated: true; capabilitySummary: string };
};
export type EasyEmailMailAccountSmtpTestRequest = { accountId: string; credentialRefId: string };
export type EasyEmailMailAccountSmtpTestResponse = {
  result: { authenticated: true; capabilitySummary: string };
};

export type EasyEmailMailImapFolderKind =
  | "inbox"
  | "archive"
  | "spam"
  | "trash"
  | "sent"
  | "drafts"
  | "mail";

export type EasyEmailMailAccountSyncState =
  | "never_synced"
  | "syncing"
  | "synced"
  | "stale"
  | "auth_failed"
  | "error";

export type EasyEmailMailImapFolder = {
  id: string;
  accountId: string;
  sourceRefId: string;
  providerFolderId: string;
  displayName: string;
  path: string;
  delimiter: string;
  folderKind: EasyEmailMailImapFolderKind;
  specialUse?: string;
  uidValidity?: string;
  lastSeenUid?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EasyEmailMailAccountSyncStatus = {
  accountId: string;
  syncState: EasyEmailMailAccountSyncState;
  isStale: boolean;
  staleAfterMs: number;
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  lastFetchedCount: number;
  lastInsertedCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  folderCount: number;
};

export type EasyEmailMailAccountSyncRequest = {
  limit?: number | null;
  folderKinds?: EasyEmailMailImapFolderKind[];
};

export type EasyEmailMailAccountFolderSyncSummary = {
  folderId: string;
  path: string;
  folderKind: EasyEmailMailImapFolderKind;
  fetchedCount: number;
  insertedCount: number;
  uidValidityChanged: boolean;
};

export type EasyEmailMailAccountSyncResult = {
  accountId: string;
  primaryFolderId: string;
  fetchedCount: number;
  insertedCount: number;
  uidValidityChangedCount: number;
  folders: EasyEmailMailAccountFolderSyncSummary[];
  syncedAt: string;
};

export type EasyEmailListMailAccountFoldersResponse = {
  folders: EasyEmailMailImapFolder[];
  refreshed: boolean;
};

export type EasyEmailGetMailAccountSyncStatusResponse = {
  status: EasyEmailMailAccountSyncStatus;
};

export type EasyEmailSyncMailAccountResponse = {
  sync: EasyEmailMailAccountSyncResult;
  status: EasyEmailMailAccountSyncStatus;
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

export type EasyEmailPromoteMailboxRequest = {
  confirmLifecycleAck: boolean;
  displayName?: string | null;
};

export type EasyEmailPromoteMailboxResponse = {
  account: EasyEmailMailAccount;
  session: EasyEmailMailboxSession;
  linkedMessageCount: number;
};

export type EasyEmailNewsletterSubscription = {
  id: string;
  listId: string;
  senderAddress: string;
  name: string;
  receivedMessageCount: number;
  unreadMessageCount: number;
  lastReceivedAt: string;
  unsubscribeMethods: string[];
  spam: boolean;
  hidden: boolean;
};

export type EasyEmailListNewsletterSubscriptionsQuery = {
  accountId: string;
};

export type EasyEmailListNewsletterSubscriptionsResponse = {
  subscriptions: EasyEmailNewsletterSubscription[];
};

export type EasyEmailUpdateNewsletterSubscriptionRequest = {
  accountId: string;
  hidden: boolean;
};

export type EasyEmailNewsletterSubscriptionActionResult = {
  accountId: string;
  subscriptionId: string;
  hidden: boolean;
  changed: boolean;
};

export type EasyEmailUpdateNewsletterSubscriptionResponse = {
  action: EasyEmailNewsletterSubscriptionActionResult;
};

export type EasyEmailClientSettings = {
  serviceUrl: string | null;
  hasApiToken: boolean;
};

export type EasyEmailGetEasyEmailSettingsResponse = {
  settings: EasyEmailClientSettings;
};

export type EasyEmailUpdateEasyEmailSettingsRequest = {
  serviceUrl: string;
};

export type EasyEmailUpdateEasyEmailSettingsResponse = {
  settings: EasyEmailClientSettings;
};

export type EasyEmailTestEasyEmailConnectionRequest = {
  serviceUrl?: string | null;
  apiToken?: string | null;
};

export type EasyEmailConnectionHealth = {
  reachable: boolean;
  providerCount: number;
  authStatus: string;
  capabilitiesSummary: string;
};

export type EasyEmailTestEasyEmailConnectionResponse = {
  health: EasyEmailConnectionHealth;
};

