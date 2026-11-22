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
  promoteMailboxSession(
    sessionId: string,
    input: Contracts.PromoteMailboxSessionInput,
  ): Promise<Contracts.PromoteMailboxSessionResult>;
  listNewsletterSubscriptions(
    query: Contracts.MailNewsletterSubscriptionListQuery,
  ): Promise<Contracts.MailNewsletterSubscription[]>;
  setNewsletterSubscriptionHidden(
    subscriptionId: string,
    input: Contracts.MailNewsletterSubscriptionUpdateInput,
  ): Promise<Contracts.MailNewsletterSubscriptionActionResult>;
  getEasyEmailSettings(): Promise<Contracts.EasyEmailClientSettings>;
  updateEasyEmailSettings(
    input: Contracts.EasyEmailClientSettingsUpdateInput,
  ): Promise<Contracts.EasyEmailClientSettings>;
  testEasyEmailConnection(
    input?: Contracts.EasyEmailConnectionTestInput,
  ): Promise<Contracts.EasyEmailConnectionHealth>;
  listAgentMailAccounts(
    query?: Contracts.MailAgentAccountListQuery,
  ): Promise<Contracts.MailAgentAccountListResult>;
  createAgentMailAccount(
    input: Contracts.MailAgentAccountCreateInput,
  ): Promise<Contracts.MailAccount>;
  listAgentMailServices(): Promise<Contracts.MailAgentServiceRecord[]>;
  createAgentMailService(
    input: Contracts.MailAgentServiceCreateInput,
  ): Promise<Contracts.MailAgentServiceRecord>;
  sendAgentMailTask(
    input: Contracts.MailAgentTaskSendInput,
    options?: { idempotencyKey?: string },
  ): Promise<Contracts.MailAgentTaskSendResult>;
  listAgentMailThreads(
    query?: Contracts.MailAgentThreadListQuery,
  ): Promise<Contracts.MailAgentThread[]>;
  getAgentMailThreadDetail(threadId: string): Promise<Contracts.MailAgentThreadDetail>;
  getMailAvatarSettings(): Promise<Contracts.MailAvatarSettings>;
  updateMailAvatarSettings(
    input: Contracts.MailAvatarSettingsUpdateInput,
  ): Promise<Contracts.MailAvatarSettings>;
  resolveMailSenderAvatars(
    input: Contracts.MailAvatarResolveInput,
  ): Promise<Contracts.MailSenderAvatar[]>;
  setMailContactAvatar(
    contactId: string,
    input: Contracts.MailContactAvatarSetInput,
  ): Promise<Contracts.MailSenderAvatar>;
  clearMailContactAvatar(contactId: string): Promise<Contracts.MailContactAvatarClearResult>;
  clearMailAvatarCache(
    input?: Contracts.MailAvatarClearCacheInput,
  ): Promise<Contracts.MailAvatarClearCacheResult>;
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

  public async promoteMailboxSession(
    sessionId: string,
    input: Contracts.PromoteMailboxSessionInput,
  ): Promise<Contracts.PromoteMailboxSessionResult> {
    return this.httpClient.post<
      Contracts.PromoteMailboxSessionInput,
      Contracts.PromoteMailboxSessionResult
    >(EASY_EMAIL_HTTP_ROUTES.promoteMailbox(sessionId), input);
  }

  public async listNewsletterSubscriptions(
    query: Contracts.MailNewsletterSubscriptionListQuery,
  ): Promise<Contracts.MailNewsletterSubscription[]> {
    const response = await this.httpClient.get<Contracts.ListNewsletterSubscriptionsResult>(
      EASY_EMAIL_HTTP_ROUTES.newsletterSubscriptions,
      { accountId: query.accountId },
    );
    return response.subscriptions;
  }

  public async setNewsletterSubscriptionHidden(
    subscriptionId: string,
    input: Contracts.MailNewsletterSubscriptionUpdateInput,
  ): Promise<Contracts.MailNewsletterSubscriptionActionResult> {
    const response = await this.httpClient.patch<
      Contracts.MailNewsletterSubscriptionUpdateInput,
      { action: Contracts.MailNewsletterSubscriptionActionResult }
    >(EASY_EMAIL_HTTP_ROUTES.newsletterSubscription(subscriptionId), input);
    return response.action;
  }

  public async getEasyEmailSettings(): Promise<Contracts.EasyEmailClientSettings> {
    const response = await this.httpClient.get<{ settings: Contracts.EasyEmailClientSettings }>(
      EASY_EMAIL_HTTP_ROUTES.settingsEasyEmail,
    );
    return response.settings;
  }

  public async updateEasyEmailSettings(
    input: Contracts.EasyEmailClientSettingsUpdateInput,
  ): Promise<Contracts.EasyEmailClientSettings> {
    const response = await this.httpClient.patch<
      Contracts.EasyEmailClientSettingsUpdateInput,
      { settings: Contracts.EasyEmailClientSettings }
    >(EASY_EMAIL_HTTP_ROUTES.settingsEasyEmail, input);
    return response.settings;
  }

  public async testEasyEmailConnection(
    input: Contracts.EasyEmailConnectionTestInput = {},
  ): Promise<Contracts.EasyEmailConnectionHealth> {
    const response = await this.httpClient.post<
      Contracts.EasyEmailConnectionTestInput,
      { health: Contracts.EasyEmailConnectionHealth }
    >(EASY_EMAIL_HTTP_ROUTES.testSettingsEasyEmail, input);
    return response.health;
  }

  public async listAgentMailAccounts(
    query: Contracts.MailAgentAccountListQuery = {},
  ): Promise<Contracts.MailAgentAccountListResult> {
    return this.httpClient.get<Contracts.MailAgentAccountListResult>(
      EASY_EMAIL_HTTP_ROUTES.agentAccounts,
      { limit: query.limit, cursor: query.cursor },
    );
  }

  public async createAgentMailAccount(
    input: Contracts.MailAgentAccountCreateInput,
  ): Promise<Contracts.MailAccount> {
    const response = await this.httpClient.post<
      Contracts.MailAgentAccountCreateInput,
      { account: Contracts.MailAccount }
    >(EASY_EMAIL_HTTP_ROUTES.agentAccounts, input);
    return response.account;
  }

  public async listAgentMailServices(): Promise<Contracts.MailAgentServiceRecord[]> {
    const response = await this.httpClient.get<{ services: Contracts.MailAgentServiceRecord[] }>(
      EASY_EMAIL_HTTP_ROUTES.agentServices,
    );
    return response.services;
  }

  public async createAgentMailService(
    input: Contracts.MailAgentServiceCreateInput,
  ): Promise<Contracts.MailAgentServiceRecord> {
    const response = await this.httpClient.post<
      Contracts.MailAgentServiceCreateInput,
      { service: Contracts.MailAgentServiceRecord }
    >(EASY_EMAIL_HTTP_ROUTES.agentServices, input);
    return response.service;
  }

  public async sendAgentMailTask(
    input: Contracts.MailAgentTaskSendInput,
    options: { idempotencyKey?: string } = {},
  ): Promise<Contracts.MailAgentTaskSendResult> {
    const idempotencyKey = options.idempotencyKey?.trim() || input.idempotencyKey?.trim();
    return this.httpClient.post<
      Contracts.MailAgentTaskSendInput,
      Contracts.MailAgentTaskSendResult
    >(
      EASY_EMAIL_HTTP_ROUTES.agentTasks,
      input,
      idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
    );
  }

  public async listAgentMailThreads(
    query: Contracts.MailAgentThreadListQuery = {},
  ): Promise<Contracts.MailAgentThread[]> {
    const response = await this.httpClient.get<{ threads: Contracts.MailAgentThread[] }>(
      EASY_EMAIL_HTTP_ROUTES.agentThreads,
      {
        status: query.status,
        senderAccountId: query.senderAccountId,
        agentServiceId: query.agentServiceId,
        limit: query.limit,
      },
    );
    return response.threads;
  }

  public async getAgentMailThreadDetail(
    threadId: string,
  ): Promise<Contracts.MailAgentThreadDetail> {
    const response = await this.httpClient.get<{ detail: Contracts.MailAgentThreadDetail }>(
      EASY_EMAIL_HTTP_ROUTES.agentThread(threadId),
    );
    return response.detail;
  }

  public async getMailAvatarSettings(): Promise<Contracts.MailAvatarSettings> {
    const response = await this.httpClient.get<{ settings: Contracts.MailAvatarSettings }>(
      EASY_EMAIL_HTTP_ROUTES.avatarSettings,
    );
    return response.settings;
  }

  public async updateMailAvatarSettings(
    input: Contracts.MailAvatarSettingsUpdateInput,
  ): Promise<Contracts.MailAvatarSettings> {
    const response = await this.httpClient.patch<
      Contracts.MailAvatarSettingsUpdateInput,
      { settings: Contracts.MailAvatarSettings }
    >(EASY_EMAIL_HTTP_ROUTES.avatarSettings, input);
    return response.settings;
  }

  public async resolveMailSenderAvatars(
    input: Contracts.MailAvatarResolveInput,
  ): Promise<Contracts.MailSenderAvatar[]> {
    const response = await this.httpClient.post<
      Contracts.MailAvatarResolveInput,
      { avatars: Contracts.MailSenderAvatar[] }
    >(EASY_EMAIL_HTTP_ROUTES.avatarResolve, input);
    return response.avatars;
  }

  public async setMailContactAvatar(
    contactId: string,
    input: Contracts.MailContactAvatarSetInput,
  ): Promise<Contracts.MailSenderAvatar> {
    const response = await this.httpClient.put<
      Contracts.MailContactAvatarSetInput,
      { avatar: Contracts.MailSenderAvatar }
    >(EASY_EMAIL_HTTP_ROUTES.avatarContact(contactId), input);
    return response.avatar;
  }

  public async clearMailContactAvatar(
    contactId: string,
  ): Promise<Contracts.MailContactAvatarClearResult> {
    const response = await this.httpClient.delete<{
      result: Contracts.MailContactAvatarClearResult;
    }>(EASY_EMAIL_HTTP_ROUTES.avatarContact(contactId));
    return response.result;
  }

  public async clearMailAvatarCache(
    input: Contracts.MailAvatarClearCacheInput = {},
  ): Promise<Contracts.MailAvatarClearCacheResult> {
    const response = await this.httpClient.delete<{
      result: Contracts.MailAvatarClearCacheResult;
    }>(EASY_EMAIL_HTTP_ROUTES.avatarCache, {
      includeContacts: input.includeContacts,
    });
    return response.result;
  }
}
