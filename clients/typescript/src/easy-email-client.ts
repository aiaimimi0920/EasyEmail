import type * as Contracts from "./contracts.js";
import {
  EasyEmailMessageClientBase,
  type EasyEmailMessageClientApi,
} from "./client-message-base.js";
import { EASY_EMAIL_HTTP_ROUTES } from "./http-transport.js";

export interface EasyEmailClientApi extends EasyEmailMessageClientApi {
  listContacts(query?: Contracts.ContactListQuery): Promise<Contracts.ContactListResult>;
  getContact(contactId: string): Promise<Contracts.Contact>;
  createContact(input: Contracts.ContactCreateInput): Promise<Contracts.Contact>;
  updateContact(contactId: string, input: Contracts.ContactUpdateInput): Promise<Contracts.Contact>;
  deleteContact(contactId: string, expectedVersion: number): Promise<{ id: string }>;
  listMailTaxonomy(query: Contracts.MailTaxonomyListQuery): Promise<Contracts.MailTaxonomyListResult>;
  getMailTaxonomy(itemId: string): Promise<Contracts.MailTaxonomyMutationResult>;
  upsertMailTaxonomy(
    kind: Contracts.MailTaxonomyKind,
    key: string,
    input: Contracts.MailTaxonomyUpsertInput,
  ): Promise<Contracts.MailTaxonomyMutationResult>;
  updateMailTaxonomy(
    itemId: string,
    input: Contracts.MailTaxonomyUpdateInput,
  ): Promise<Contracts.MailTaxonomyMutationResult>;
  deleteMailTaxonomy(itemId: string, expectedVersion: number): Promise<Contracts.MailTaxonomyDeleteResult>;
  listMailAccounts(query?: Contracts.MailAccountListQuery): Promise<Contracts.MailAccountListResult>;
  getMailAccount(accountId: string): Promise<Contracts.MailAccount>;
  createMailAccount(input: Contracts.MailAccountCreateInput): Promise<Contracts.MailAccount>;
  updateMailAccount(accountId: string, input: Contracts.MailAccountUpdateInput): Promise<Contracts.MailAccount>;
  disableMailAccount(accountId: string, expectedVersion: number): Promise<Contracts.MailAccount>;
  deleteMailAccount(accountId: string, expectedVersion: number): Promise<{ id: string }>;
  testMailAccountImap(input: Contracts.MailAccountImapTestRequest): Promise<Contracts.MailAccountImapTestResult>;
  testMailAccountSmtp(input: Contracts.MailAccountSmtpTestRequest): Promise<Contracts.MailAccountSmtpTestResult>;
  listMailAccountFolders(
    accountId: string,
    options?: { refresh?: boolean },
  ): Promise<Contracts.ListMailAccountFoldersResult>;
  getMailAccountSyncStatus(accountId: string): Promise<Contracts.MailAccountSyncStatus>;
  syncMailAccount(
    accountId: string,
    input?: Contracts.MailAccountSyncInput,
  ): Promise<Contracts.SyncMailAccountResponse>;
}

export class EasyEmailClient extends EasyEmailMessageClientBase implements EasyEmailClientApi {
  public async listContacts(query: Contracts.ContactListQuery = {}): Promise<Contracts.ContactListResult> {
    return this.httpClient.get<Contracts.ContactListResult>(EASY_EMAIL_HTTP_ROUTES.contacts, {
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async getContact(contactId: string): Promise<Contracts.Contact> {
    const response = await this.httpClient.get<{ contact: Contracts.Contact }>(
      EASY_EMAIL_HTTP_ROUTES.contact(contactId),
    );
    return response.contact;
  }

  public async createContact(input: Contracts.ContactCreateInput): Promise<Contracts.Contact> {
    const response = await this.httpClient.post<Contracts.ContactCreateInput, { contact: Contracts.Contact }>(
      EASY_EMAIL_HTTP_ROUTES.contacts,
      input,
    );
    return response.contact;
  }

  public async updateContact(
    contactId: string,
    input: Contracts.ContactUpdateInput,
  ): Promise<Contracts.Contact> {
    const response = await this.httpClient.patch<Contracts.ContactUpdateInput, { contact: Contracts.Contact }>(
      EASY_EMAIL_HTTP_ROUTES.contact(contactId),
      input,
    );
    return response.contact;
  }

  public async deleteContact(contactId: string, expectedVersion: number): Promise<{ id: string }> {
    const response = await this.httpClient.delete<{ deleted: { id: string } }>(
      EASY_EMAIL_HTTP_ROUTES.contact(contactId),
      { expectedVersion },
    );
    return response.deleted;
  }

  public async listMailTaxonomy(
    query: Contracts.MailTaxonomyListQuery,
  ): Promise<Contracts.MailTaxonomyListResult> {
    return this.httpClient.get<Contracts.MailTaxonomyListResult>(EASY_EMAIL_HTTP_ROUTES.taxonomy, {
      kind: query.kind,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async getMailTaxonomy(itemId: string): Promise<Contracts.MailTaxonomyMutationResult> {
    return this.httpClient.get<Contracts.MailTaxonomyMutationResult>(
      EASY_EMAIL_HTTP_ROUTES.taxonomyItem(itemId),
    );
  }

  public async upsertMailTaxonomy(
    kind: Contracts.MailTaxonomyKind,
    key: string,
    input: Contracts.MailTaxonomyUpsertInput,
  ): Promise<Contracts.MailTaxonomyMutationResult> {
    return this.httpClient.put<Contracts.MailTaxonomyUpsertInput, Contracts.MailTaxonomyMutationResult>(
      EASY_EMAIL_HTTP_ROUTES.taxonomyUpsert(kind, key),
      input,
    );
  }

  public async updateMailTaxonomy(
    itemId: string,
    input: Contracts.MailTaxonomyUpdateInput,
  ): Promise<Contracts.MailTaxonomyMutationResult> {
    return this.httpClient.patch<Contracts.MailTaxonomyUpdateInput, Contracts.MailTaxonomyMutationResult>(
      EASY_EMAIL_HTTP_ROUTES.taxonomyItem(itemId),
      input,
    );
  }

  public async deleteMailTaxonomy(
    itemId: string,
    expectedVersion: number,
  ): Promise<Contracts.MailTaxonomyDeleteResult> {
    return this.httpClient.delete<Contracts.MailTaxonomyDeleteResult>(
      EASY_EMAIL_HTTP_ROUTES.taxonomyItem(itemId),
      { expectedVersion },
    );
  }

  public async listMailAccounts(
    query: Contracts.MailAccountListQuery = {},
  ): Promise<Contracts.MailAccountListResult> {
    return this.httpClient.get<Contracts.MailAccountListResult>(EASY_EMAIL_HTTP_ROUTES.accounts, {
      scope: query.scope,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async getMailAccount(accountId: string): Promise<Contracts.MailAccount> {
    const response = await this.httpClient.get<{ account: Contracts.MailAccount }>(
      EASY_EMAIL_HTTP_ROUTES.account(accountId),
    );
    return response.account;
  }

  public async createMailAccount(input: Contracts.MailAccountCreateInput): Promise<Contracts.MailAccount> {
    const response = await this.httpClient.post<
      Contracts.MailAccountCreateInput,
      { account: Contracts.MailAccount }
    >(EASY_EMAIL_HTTP_ROUTES.accounts, input);
    return response.account;
  }

  public async updateMailAccount(
    accountId: string,
    input: Contracts.MailAccountUpdateInput,
  ): Promise<Contracts.MailAccount> {
    const response = await this.httpClient.patch<
      Contracts.MailAccountUpdateInput,
      { account: Contracts.MailAccount }
    >(EASY_EMAIL_HTTP_ROUTES.account(accountId), input);
    return response.account;
  }

  public async disableMailAccount(accountId: string, expectedVersion: number): Promise<Contracts.MailAccount> {
    const response = await this.httpClient.post<
      { expectedVersion: number },
      { account: Contracts.MailAccount }
    >(EASY_EMAIL_HTTP_ROUTES.disableAccount(accountId), { expectedVersion });
    return response.account;
  }

  public async deleteMailAccount(accountId: string, expectedVersion: number): Promise<{ id: string }> {
    const response = await this.httpClient.delete<{ deleted: { id: string } }>(
      EASY_EMAIL_HTTP_ROUTES.account(accountId),
      { expectedVersion },
    );
    return response.deleted;
  }

  public async testMailAccountImap(
    input: Contracts.MailAccountImapTestRequest,
  ): Promise<Contracts.MailAccountImapTestResult> {
    const response = await this.httpClient.post<
      Contracts.MailAccountImapTestRequest,
      { result: Contracts.MailAccountImapTestResult }
    >(EASY_EMAIL_HTTP_ROUTES.testAccountImap, input);
    return response.result;
  }

  public async testMailAccountSmtp(
    input: Contracts.MailAccountSmtpTestRequest,
  ): Promise<Contracts.MailAccountSmtpTestResult> {
    const response = await this.httpClient.post<
      Contracts.MailAccountSmtpTestRequest,
      { result: Contracts.MailAccountSmtpTestResult }
    >(EASY_EMAIL_HTTP_ROUTES.testAccountSmtp, input);
    return response.result;
  }

  public async listMailAccountFolders(
    accountId: string,
    options: { refresh?: boolean } = {},
  ): Promise<Contracts.ListMailAccountFoldersResult> {
    return this.httpClient.get<Contracts.ListMailAccountFoldersResult>(
      EASY_EMAIL_HTTP_ROUTES.accountFolders(accountId),
      { refresh: options.refresh },
    );
  }

  public async getMailAccountSyncStatus(
    accountId: string,
  ): Promise<Contracts.MailAccountSyncStatus> {
    const response = await this.httpClient.get<{ status: Contracts.MailAccountSyncStatus }>(
      EASY_EMAIL_HTTP_ROUTES.accountSync(accountId),
    );
    return response.status;
  }

  public async syncMailAccount(
    accountId: string,
    input: Contracts.MailAccountSyncInput = {},
  ): Promise<Contracts.SyncMailAccountResponse> {
    return this.httpClient.post<
      Contracts.MailAccountSyncInput,
      Contracts.SyncMailAccountResponse
    >(EASY_EMAIL_HTTP_ROUTES.accountSync(accountId), input);
  }
}
