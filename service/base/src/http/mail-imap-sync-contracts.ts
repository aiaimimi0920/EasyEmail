import type {
  MailAccountSyncInput,
  MailAccountSyncResult,
  MailAccountSyncStatus,
  MailImapFolder,
} from "../domain/mail-imap-sync.js";

export interface ListMailAccountFoldersHttpRequest {
  refresh?: boolean;
}

export interface ListMailAccountFoldersHttpResponse {
  folders: MailImapFolder[];
  refreshed: boolean;
}

export interface GetMailAccountSyncStatusHttpResponse {
  status: MailAccountSyncStatus;
}

export type SyncMailAccountHttpRequest = MailAccountSyncInput;

export interface SyncMailAccountHttpResponse {
  sync: MailAccountSyncResult;
  status: MailAccountSyncStatus;
}
