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

import {
  openRelationalDatabase,
  releaseRelationalDatabasePath,
  type SqliteRelationalDatabaseOptions,
} from "./database-bootstrap.js";
import { SqliteContactRepository } from "./contact-repository.js";
import { SqliteMailAccountRepository } from "./mail-account-repository.js";
import { SqliteMailTaxonomyRepository } from "./mail-taxonomy-repository.js";

export type { SqliteRelationalDatabaseOptions } from "./database-bootstrap.js";
export {
  resolveRelationalDatabasePath,
  restoreRelationalDatabaseBackup,
  type RelationalDatabaseRestoreResult,
} from "./database-backup.js";

export class SqliteRelationalDatabase implements ContactRepository, MailTaxonomyRepository, MailAccountRepository {
  private readonly database: DatabaseSync;
  private readonly trackedDatabasePath?: string;
  private readonly contacts: SqliteContactRepository;
  private readonly mailAccounts: SqliteMailAccountRepository;
  private readonly mailTaxonomy: SqliteMailTaxonomyRepository;
  private closed = false;
  public readonly backupPath?: string;

  public constructor(options: SqliteRelationalDatabaseOptions) {
    const opened = openRelationalDatabase(options);
    this.database = opened.database;
    this.trackedDatabasePath = opened.trackedDatabasePath;
    this.backupPath = opened.backupPath;
    this.contacts = new SqliteContactRepository(this.database);
    this.mailAccounts = new SqliteMailAccountRepository(this.database);
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
