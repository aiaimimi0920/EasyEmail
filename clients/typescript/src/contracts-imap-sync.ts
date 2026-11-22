export type MailImapFolderKind =
  | "inbox"
  | "archive"
  | "spam"
  | "trash"
  | "sent"
  | "drafts"
  | "mail";

export type MailAccountSyncState =
  | "never_synced"
  | "syncing"
  | "synced"
  | "stale"
  | "auth_failed"
  | "error";

export interface MailImapFolder {
  id: string;
  accountId: string;
  sourceRefId: string;
  providerFolderId: string;
  displayName: string;
  path: string;
  delimiter: string;
  folderKind: MailImapFolderKind;
  specialUse?: string;
  uidValidity?: string;
  lastSeenUid?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailAccountSyncStatus {
  accountId: string;
  syncState: MailAccountSyncState;
  isStale: boolean;
  staleAfterMs: number;
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  lastFetchedCount: number;
  lastInsertedCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  folderCount: number;
}

export interface MailAccountSyncInput {
  limit?: number | null;
  folderKinds?: MailImapFolderKind[];
}

export interface MailAccountFolderSyncSummary {
  folderId: string;
  path: string;
  folderKind: MailImapFolderKind;
  fetchedCount: number;
  insertedCount: number;
  uidValidityChanged: boolean;
}

export interface MailAccountSyncResult {
  accountId: string;
  primaryFolderId: string;
  fetchedCount: number;
  insertedCount: number;
  uidValidityChangedCount: number;
  folders: MailAccountFolderSyncSummary[];
  syncedAt: string;
}

export interface ListMailAccountFoldersResult {
  folders: MailImapFolder[];
  refreshed: boolean;
}

export interface SyncMailAccountResponse {
  sync: MailAccountSyncResult;
  status: MailAccountSyncStatus;
}
