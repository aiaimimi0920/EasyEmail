import type { MailAccountImapProfile } from "./account.js";

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

export type MailImapRemoteFlag = "\\Seen" | "\\Flagged" | "\\Deleted";

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

export interface MailImapRemoteFolder {
  providerFolderId: string;
  displayName: string;
  path: string;
  delimiter: string;
  folderKind: MailImapFolderKind;
  specialUse?: string;
}

export interface MailImapRemoteMessageHeader {
  uid: string;
  rfcMessageId?: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  fromAddress: string;
  fromName?: string;
  observedAt: string;
  snippet: string;
  isRead: boolean;
  isStarred: boolean;
  isDeleted: boolean;
  hasAttachments: boolean;
  isNewsletter: boolean;
}

export interface MailImapFolderSyncBatch {
  uidValidity: string;
  uidValidityChanged: boolean;
  highestSeenUid?: string;
  headers: MailImapRemoteMessageHeader[];
}

export interface MailImapMessageBody {
  bodyText: string;
  bodyHtml?: string;
  hasAttachments: boolean;
}

export interface MailImapMoveResult {
  targetUid?: string;
  targetUidValidity?: string;
}

export interface MailImapTransport {
  discoverFolders(
    profile: MailAccountImapProfile,
    secret: string,
  ): Promise<MailImapRemoteFolder[]>;
  syncFolderHeaders(
    profile: MailAccountImapProfile,
    secret: string,
    options: {
      folderPath: string;
      knownUidValidity?: string;
      lastSeenUid?: string;
      limit: number;
    },
  ): Promise<MailImapFolderSyncBatch>;
  fetchMessageBody(
    profile: MailAccountImapProfile,
    secret: string,
    folderPath: string,
    uid: string,
  ): Promise<MailImapMessageBody | undefined>;
  setMessageFlag(
    profile: MailAccountImapProfile,
    secret: string,
    folderPath: string,
    uid: string,
    flag: MailImapRemoteFlag,
    enabled: boolean,
  ): Promise<void>;
  moveMessage(
    profile: MailAccountImapProfile,
    secret: string,
    sourceFolderPath: string,
    uid: string,
    targetFolderPath: string,
  ): Promise<MailImapMoveResult>;
}

export interface MailImapStoredCheckpoint {
  accountId: string;
  syncState: Exclude<MailAccountSyncState, "stale">;
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  lastFetchedCount: number;
  lastInsertedCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  updatedAt: string;
}

export interface MailImapMessageSourceContext {
  sourceRowId: string;
  messageId: string;
  accountId: string;
  sourceRefId: string;
  folderId: string;
  folderPath: string;
  folderKind: MailImapFolderKind;
  imapUid: string;
  imapUidValidity?: string;
  bodyCacheState: "none" | "cached";
}

export interface MailImapFolderIngestInput {
  accountId: string;
  sourceRefId: string;
  receivedAddress: string;
  providerLabel: string;
  folder: MailImapFolder;
  batch: MailImapFolderSyncBatch;
  now: string;
}

export interface MailImapFolderIngestResult {
  fetchedCount: number;
  insertedCount: number;
  insertedMessageIds: string[];
}

export interface MailImapRepository {
  upsertImapFolders(
    accountId: string,
    sourceRefId: string,
    folders: MailImapRemoteFolder[],
    now: string,
  ): Promise<MailImapFolder[]>;
  listImapFolders(accountId: string): Promise<MailImapFolder[]>;
  ingestImapFolderBatch(input: MailImapFolderIngestInput): Promise<MailImapFolderIngestResult>;
  getSyncCheckpoint(accountId: string): Promise<MailImapStoredCheckpoint | undefined>;
  upsertSyncCheckpoint(input: MailImapStoredCheckpoint): Promise<void>;
  getImapMessageSourceContext(messageId: string): Promise<MailImapMessageSourceContext | undefined>;
  cacheMailMessageBody(
    messageId: string,
    bodyText: string,
    bodyHtml: string | undefined,
    snippet: string,
    hasAttachments: boolean,
    now: string,
  ): Promise<void>;
  updateImapMessageSourceFolderAndUid(
    sourceRowId: string,
    targetFolderId: string,
    targetUid: string | undefined,
    targetUidValidity: string | undefined,
    now: string,
  ): Promise<void>;
}
