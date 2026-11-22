import { DatabaseSync } from "node:sqlite";

import type {
  MailAccount,
  MailAccountRepository,
  MailAccountRepositoryCreateInput,
  MailAccountRepositoryListQuery,
  MailAccountRepositoryListResult,
  MailAccountRepositoryUpdateInput,
} from "../../domain/account.js";
import type {
  Contact,
  ContactRepository,
  ContactRepositoryCreateInput,
  ContactRepositoryListQuery,
  ContactRepositoryListResult,
  ContactRepositoryUpdateInput,
} from "../../domain/contact.js";
import type {
  MailTaxonomyItem,
  MailTaxonomyRepository,
  MailTaxonomyRepositoryListQuery,
  MailTaxonomyRepositoryListResult,
  MailTaxonomyUpdateInput,
  MailTaxonomyUpsertInput,
} from "../../domain/mail-taxonomy.js";
import type {
  MailDraftRepositoryUpsertInput,
  MailDraftSaveResult,
  MailMessageClassification,
  MailMessageDetail,
  MailMessageDetailScope,
  MailMessageFlagName,
  MailMessageIngestInput,
  MailMessageIngestResult,
  MailMessageRepository,
  MailMessageRepositoryListQuery,
  MailMessageRepositoryListResult,
  MailVerificationListQuery,
  MailVerificationRecord,
  MailVerificationRepository,
  MailVerificationUpsertInput,
  StoredMessageVerificationSource,
} from "../../domain/mail-message.js";

import {
  openRelationalDatabase,
  releaseRelationalDatabasePath,
  type SqliteRelationalDatabaseOptions,
} from "./database-bootstrap.js";
import { SqliteContactRepository } from "./contact-repository.js";
import { SqliteMailAccountRepository } from "./mail-account-repository.js";
import { SqliteMailMessageRepository } from "./mail-message-repository.js";
import { SqliteMailTaxonomyRepository } from "./mail-taxonomy-repository.js";
import { SqliteMailVerificationRepository } from "./mail-verification-repository.js";

export type { SqliteRelationalDatabaseOptions } from "./database-bootstrap.js";
export {
  resolveRelationalDatabasePath,
  restoreRelationalDatabaseBackup,
  type RelationalDatabaseRestoreResult,
} from "./database-backup.js";
export {
  LEGACY_ACCOUNT_IMPORTER_VERSION,
  importLegacyEasyEmailAmAccounts,
  type LegacyAccountImportOptions,
  type LegacyAccountImportReceipt,
  type LegacyAccountImportResult,
  type LegacyCredentialProbeInput,
  type LegacyCredentialVaultCheck,
} from "./legacy-account-importer.js";

export class SqliteRelationalDatabase
  implements
    ContactRepository,
    MailTaxonomyRepository,
    MailAccountRepository,
    MailMessageRepository,
    MailVerificationRepository
{
  private readonly database: DatabaseSync;
  private readonly trackedDatabasePath?: string;
  private readonly contacts: SqliteContactRepository;
  private readonly mailAccounts: SqliteMailAccountRepository;
  private readonly mailMessages: SqliteMailMessageRepository;
  private readonly mailTaxonomy: SqliteMailTaxonomyRepository;
  private readonly mailVerifications: SqliteMailVerificationRepository;
  private closed = false;
  public readonly backupPath?: string;

  public constructor(options: SqliteRelationalDatabaseOptions) {
    const opened = openRelationalDatabase(options);
    this.database = opened.database;
    this.trackedDatabasePath = opened.trackedDatabasePath;
    this.backupPath = opened.backupPath;
    this.contacts = new SqliteContactRepository(this.database);
    this.mailAccounts = new SqliteMailAccountRepository(this.database);
    this.mailMessages = new SqliteMailMessageRepository(this.database);
    this.mailTaxonomy = new SqliteMailTaxonomyRepository(this.database);
    this.mailVerifications = new SqliteMailVerificationRepository(this.database);
  }

  public listContacts(query: ContactRepositoryListQuery): Promise<ContactRepositoryListResult> {
    return this.contacts.listContacts(query);
  }

  public getContact(id: string): Promise<Contact | undefined> {
    return this.contacts.getContact(id);
  }

  public createContact(input: ContactRepositoryCreateInput): Promise<Contact> {
    return this.contacts.createContact(input);
  }

  public updateContact(input: ContactRepositoryUpdateInput): Promise<Contact | undefined> {
    return this.contacts.updateContact(input);
  }

  public deleteContact(id: string, expectedVersion: number): Promise<boolean> {
    return this.contacts.deleteContact(id, expectedVersion);
  }

  public listMailTaxonomyItems(
    query: MailTaxonomyRepositoryListQuery,
  ): Promise<MailTaxonomyRepositoryListResult> {
    return this.mailTaxonomy.listMailTaxonomyItems(query);
  }

  public getMailTaxonomyItem(id: string): Promise<MailTaxonomyItem | undefined> {
    return this.mailTaxonomy.getMailTaxonomyItem(id);
  }

  public upsertMailTaxonomyItem(input: MailTaxonomyUpsertInput): Promise<MailTaxonomyItem> {
    return this.mailTaxonomy.upsertMailTaxonomyItem(input);
  }

  public updateMailTaxonomyItem(
    input: MailTaxonomyUpdateInput,
  ): Promise<MailTaxonomyItem | undefined> {
    return this.mailTaxonomy.updateMailTaxonomyItem(input);
  }

  public deleteMailTaxonomyItem(id: string, expectedVersion: number): Promise<boolean> {
    return this.mailTaxonomy.deleteMailTaxonomyItem(id, expectedVersion);
  }

  public listMailAccounts(
    query: MailAccountRepositoryListQuery,
  ): Promise<MailAccountRepositoryListResult> {
    return this.mailAccounts.listMailAccounts(query);
  }

  public getMailAccount(id: string): Promise<MailAccount | undefined> {
    return this.mailAccounts.getMailAccount(id);
  }

  public createMailAccount(input: MailAccountRepositoryCreateInput): Promise<MailAccount> {
    return this.mailAccounts.createMailAccount(input);
  }

  public updateMailAccount(
    input: MailAccountRepositoryUpdateInput,
  ): Promise<MailAccount | undefined> {
    return this.mailAccounts.updateMailAccount(input);
  }

  public disableMailAccount(
    id: string,
    expectedVersion: number,
    now: string,
  ): Promise<MailAccount | undefined> {
    return this.mailAccounts.disableMailAccount(id, expectedVersion, now);
  }

  public deleteMailAccount(id: string, expectedVersion: number, now: string): Promise<boolean> {
    return this.mailAccounts.deleteMailAccount(id, expectedVersion, now);
  }

  public ingestMailMessage(input: MailMessageIngestInput): Promise<MailMessageIngestResult> {
    return this.mailMessages.ingestMailMessage(input);
  }

  public listMailMessages(
    query: MailMessageRepositoryListQuery,
  ): Promise<MailMessageRepositoryListResult> {
    return this.mailMessages.listMailMessages(query);
  }

  public getMailMessageDetail(
    id: string,
    scope?: MailMessageDetailScope,
  ): Promise<{ detail: MailMessageDetail; rawBodyHtml?: string } | undefined> {
    return this.mailMessages.getMailMessageDetail(id, scope);
  }

  public upsertLocalDraft(input: MailDraftRepositoryUpsertInput): Promise<MailDraftSaveResult> {
    return this.mailMessages.upsertLocalDraft(input);
  }

  public deleteLocalDraft(id: string, now: string): Promise<boolean> {
    return this.mailMessages.deleteLocalDraft(id, now);
  }

  public setMailMessageLocalFlag(
    id: string,
    flagName: MailMessageFlagName,
    enabled: boolean,
    now: string,
  ): Promise<boolean | undefined> {
    return this.mailMessages.setMailMessageLocalFlag(id, flagName, enabled, now);
  }

  public setMailMessageLocalFolder(
    id: string,
    folderName: string,
    now: string,
  ): Promise<boolean | undefined> {
    return this.mailMessages.setMailMessageLocalFolder(id, folderName, now);
  }

  public setMailMessageLocalLabel(
    id: string,
    labelName: string,
    enabled: boolean,
    now: string,
  ): Promise<boolean | undefined> {
    return this.mailMessages.setMailMessageLocalLabel(id, labelName, enabled, now);
  }

  public softDeleteMailMessage(id: string, now: string): Promise<boolean | undefined> {
    return this.mailMessages.softDeleteMailMessage(id, now);
  }

  public listTrashMessageIds(): Promise<string[]> {
    return this.mailMessages.listTrashMessageIds();
  }

  public promoteTemporarySessionMessages(
    sessionId: string,
    targetAccountId: string,
    now: string,
  ): Promise<number> {
    return this.mailMessages.promoteTemporarySessionMessages(sessionId, targetAccountId, now);
  }

  public getMessageForVerification(id: string): Promise<StoredMessageVerificationSource | undefined> {
    return this.mailMessages.getMessageForVerification(id);
  }

  public setMailMessageClassification(
    id: string,
    classification: MailMessageClassification,
    now: string,
  ): Promise<void> {
    return this.mailMessages.setMailMessageClassification(id, classification, now);
  }

  public upsertMailVerificationCode(
    input: MailVerificationUpsertInput,
    nowMs: number,
  ): Promise<MailVerificationRecord> {
    return this.mailVerifications.upsertMailVerificationCode(input, nowMs);
  }

  public deleteMailVerificationCodesForMessage(messageId: string): Promise<number> {
    return this.mailVerifications.deleteMailVerificationCodesForMessage(messageId);
  }

  public listMailVerificationCodes(
    query: MailVerificationListQuery,
    nowMs: number,
  ): Promise<MailVerificationRecord[]> {
    return this.mailVerifications.listMailVerificationCodes(query, nowMs);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } finally {
      releaseRelationalDatabasePath(this.trackedDatabasePath);
    }
  }
}
