import type {
  MailAccount,
  MailAccountReceiveOutcomeInput,
  MailAccountRepository,
  MailAccountRepositoryCreateInput,
  MailAccountRepositoryListQuery,
  MailAccountRepositoryListResult,
  MailAccountRepositoryUpdateInput,
  MailAccountSendOutcomeInput,
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
  MailExtensionsRepository,
  MailNewsletterSubscription,
} from "../../domain/mail-extensions.js";
import type {
  MailTaxonomyItem,
  MailTaxonomyRepository,
  MailTaxonomyRepositoryListQuery,
  MailTaxonomyRepositoryListResult,
  MailTaxonomyUpdateInput,
  MailTaxonomyUpsertInput,
} from "../../domain/mail-taxonomy.js";
import { SqliteContactRepository } from "./contact-repository.js";
import {
  openRelationalDatabase,
  releaseRelationalDatabasePath,
  type SqliteRelationalDatabaseOptions,
} from "./database-bootstrap.js";
import { SqliteMessageQueueImapDatabaseBase } from "./database-mail-base.js";
import { SqliteMailAccountRepository } from "./mail-account-repository.js";
import { SqliteMailExtensionsRepository } from "./mail-extensions-repository.js";
import { SqliteMailTaxonomyRepository } from "./mail-taxonomy-repository.js";

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
  extends SqliteMessageQueueImapDatabaseBase
  implements
    ContactRepository,
    MailTaxonomyRepository,
    MailAccountRepository,
    MailExtensionsRepository
{
  private readonly trackedDatabasePath?: string;
  private readonly contacts: SqliteContactRepository;
  private readonly mailAccounts: SqliteMailAccountRepository;
  private readonly mailExtensions: SqliteMailExtensionsRepository;
  private readonly mailTaxonomy: SqliteMailTaxonomyRepository;
  private closed = false;
  public readonly backupPath?: string;

  public constructor(options: SqliteRelationalDatabaseOptions) {
    const opened = openRelationalDatabase(options);
    super(opened.database);
    this.trackedDatabasePath = opened.trackedDatabasePath;
    this.backupPath = opened.backupPath;
    this.contacts = new SqliteContactRepository(this.database);
    this.mailAccounts = new SqliteMailAccountRepository(this.database);
    this.mailExtensions = new SqliteMailExtensionsRepository(this.database);
    this.mailTaxonomy = new SqliteMailTaxonomyRepository(this.database);
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

  public deleteMailTaxonomyItem(id: string, expectedVersion: number, now?: string): Promise<boolean> {
    return this.mailTaxonomy.deleteMailTaxonomyItem(id, expectedVersion, now);
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

  public recordMailAccountSendOutcome(input: MailAccountSendOutcomeInput): Promise<void> {
    return this.mailAccounts.recordMailAccountSendOutcome(input);
  }

  public recordMailAccountReceiveOutcome(input: MailAccountReceiveOutcomeInput): Promise<void> {
    return this.mailAccounts.recordMailAccountReceiveOutcome(input);
  }

  public listNewsletterSubscriptions(accountId: string): Promise<MailNewsletterSubscription[]> {
    return this.mailExtensions.listNewsletterSubscriptions(accountId);
  }

  public setNewsletterSubscriptionHidden(
    accountId: string,
    subscriptionId: string,
    hidden: boolean,
    now: string,
  ): Promise<boolean> {
    return this.mailExtensions.setNewsletterSubscriptionHidden(accountId, subscriptionId, hidden, now);
  }

  public getClientSetting(settingKey: string): Promise<string | undefined> {
    return this.mailExtensions.getClientSetting(settingKey);
  }

  public setClientSetting(
    settingKey: string,
    settingValue: string | null,
    now: string,
  ): Promise<void> {
    return this.mailExtensions.setClientSetting(settingKey, settingValue, now);
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
