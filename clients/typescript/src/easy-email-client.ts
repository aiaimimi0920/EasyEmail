import type {
  AuthenticationLinkResult,
  Contact,
  ContactCreateInput,
  ContactListQuery,
  ContactListResult,
  ContactUpdateInput,
  EasyEmailCatalog,
  EasyEmailSnapshot,
  MailTaxonomyDeleteResult,
  MailTaxonomyKind,
  MailTaxonomyListQuery,
  MailTaxonomyListResult,
  MailTaxonomyMutationResult,
  MailTaxonomyUpdateInput,
  MailTaxonomyUpsertInput,
  MailAccount,
  MailAccountCreateInput,
  MailAccountImapTestRequest,
  MailAccountImapTestResult,
  MailAccountListQuery,
  MailAccountListResult,
  MailAccountUpdateInput,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxPlanResult,
  MailboxSendRequest,
  MailboxSendResult,
  MailboxSession,
  MailboxSessionUpdateRequest,
  ObserveMessageInput,
  ObservedMessage,
  ObservedMessageQueryFilters,
  RecoverMailboxByEmailRequest,
  RecoverMailboxByEmailResult,
  RecoverMailboxCapacityRequest,
  RecoverMailboxCapacityResult,
  ReleaseMailboxRequest,
  ReleaseMailboxResult,
  VerificationCodeResult,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "./contracts.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  createFetchJsonHttpClient,
} from "./http-transport.js";
import type {
  FetchJsonHttpClientOptions,
  JsonHttpClient,
} from "./http-transport.js";

export interface EasyEmailClientApi {
  getCatalog(): Promise<EasyEmailCatalog>;
  getSnapshot(): Promise<EasyEmailSnapshot>;
  listContacts(query?: ContactListQuery): Promise<ContactListResult>;
  getContact(contactId: string): Promise<Contact>;
  createContact(input: ContactCreateInput): Promise<Contact>;
  updateContact(contactId: string, input: ContactUpdateInput): Promise<Contact>;
  deleteContact(contactId: string, expectedVersion: number): Promise<{ id: string }>;
  listMailTaxonomy(query: MailTaxonomyListQuery): Promise<MailTaxonomyListResult>;
  getMailTaxonomy(itemId: string): Promise<MailTaxonomyMutationResult>;
  upsertMailTaxonomy(
    kind: MailTaxonomyKind,
    key: string,
    input: MailTaxonomyUpsertInput,
  ): Promise<MailTaxonomyMutationResult>;
  updateMailTaxonomy(
    itemId: string,
    input: MailTaxonomyUpdateInput,
  ): Promise<MailTaxonomyMutationResult>;
  deleteMailTaxonomy(itemId: string, expectedVersion: number): Promise<MailTaxonomyDeleteResult>;
  listMailAccounts(query?: MailAccountListQuery): Promise<MailAccountListResult>;
  getMailAccount(accountId: string): Promise<MailAccount>;
  createMailAccount(input: MailAccountCreateInput): Promise<MailAccount>;
  updateMailAccount(accountId: string, input: MailAccountUpdateInput): Promise<MailAccount>;
  disableMailAccount(accountId: string, expectedVersion: number): Promise<MailAccount>;
  deleteMailAccount(accountId: string, expectedVersion: number): Promise<{ id: string }>;
  testMailAccountImap(input: MailAccountImapTestRequest): Promise<MailAccountImapTestResult>;
  planMailbox(request: VerificationMailboxRequest): Promise<MailboxPlanResult>;
  openMailbox(request: VerificationMailboxRequest): Promise<VerificationMailboxOpenResult>;
  sendMailboxMessage(request: MailboxSendRequest): Promise<MailboxSendResult>;
  updateMailboxSession(request: MailboxSessionUpdateRequest): Promise<MailboxSession>;
  releaseMailbox(request: ReleaseMailboxRequest): Promise<ReleaseMailboxResult>;
  recoverMailboxByEmail(request: RecoverMailboxByEmailRequest): Promise<RecoverMailboxByEmailResult>;
  recoverMailboxCapacity(request: RecoverMailboxCapacityRequest): Promise<RecoverMailboxCapacityResult>;
  readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined>;
  readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined>;
  reportMailboxOutcome(report: MailboxOutcomeReport): Promise<MailboxOutcomeReportResult>;
  observeMessage(input: ObserveMessageInput): Promise<ObservedMessage>;
  listObservedMessages(filters?: ObservedMessageQueryFilters): Promise<ObservedMessage[]>;
  getObservedMessage(messageId: string): Promise<ObservedMessage | undefined>;
}

export class EasyEmailClient implements EasyEmailClientApi {
  private readonly httpClient: JsonHttpClient;

  public constructor(options: FetchJsonHttpClientOptions | JsonHttpClient) {
    this.httpClient = "baseUrl" in options
      ? createFetchJsonHttpClient(options)
      : options;
  }

  public async getCatalog(): Promise<EasyEmailCatalog> {
    const response = await this.httpClient.get<{ catalog: EasyEmailCatalog }>(EASY_EMAIL_HTTP_ROUTES.catalog);
    return response.catalog;
  }

  public async getSnapshot(): Promise<EasyEmailSnapshot> {
    const response = await this.httpClient.get<{ snapshot: EasyEmailSnapshot }>(EASY_EMAIL_HTTP_ROUTES.snapshot);
    return response.snapshot;
  }

  public async listContacts(query: ContactListQuery = {}): Promise<ContactListResult> {
    return this.httpClient.get<ContactListResult>(EASY_EMAIL_HTTP_ROUTES.contacts, {
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async getContact(contactId: string): Promise<Contact> {
    const response = await this.httpClient.get<{ contact: Contact }>(
      EASY_EMAIL_HTTP_ROUTES.contact(contactId),
    );
    return response.contact;
  }

  public async createContact(input: ContactCreateInput): Promise<Contact> {
    const response = await this.httpClient.post<ContactCreateInput, { contact: Contact }>(
      EASY_EMAIL_HTTP_ROUTES.contacts,
      input,
    );
    return response.contact;
  }

  public async updateContact(contactId: string, input: ContactUpdateInput): Promise<Contact> {
    const response = await this.httpClient.patch<ContactUpdateInput, { contact: Contact }>(
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

  public async listMailTaxonomy(query: MailTaxonomyListQuery): Promise<MailTaxonomyListResult> {
    return this.httpClient.get<MailTaxonomyListResult>(EASY_EMAIL_HTTP_ROUTES.taxonomy, {
      kind: query.kind,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async getMailTaxonomy(itemId: string): Promise<MailTaxonomyMutationResult> {
    return this.httpClient.get<MailTaxonomyMutationResult>(
      EASY_EMAIL_HTTP_ROUTES.taxonomyItem(itemId),
    );
  }

  public async upsertMailTaxonomy(
    kind: MailTaxonomyKind,
    key: string,
    input: MailTaxonomyUpsertInput,
  ): Promise<MailTaxonomyMutationResult> {
    return this.httpClient.put<MailTaxonomyUpsertInput, MailTaxonomyMutationResult>(
      EASY_EMAIL_HTTP_ROUTES.taxonomyUpsert(kind, key),
      input,
    );
  }

  public async updateMailTaxonomy(
    itemId: string,
    input: MailTaxonomyUpdateInput,
  ): Promise<MailTaxonomyMutationResult> {
    return this.httpClient.patch<MailTaxonomyUpdateInput, MailTaxonomyMutationResult>(
      EASY_EMAIL_HTTP_ROUTES.taxonomyItem(itemId),
      input,
    );
  }

  public async deleteMailTaxonomy(
    itemId: string,
    expectedVersion: number,
  ): Promise<MailTaxonomyDeleteResult> {
    return this.httpClient.delete<MailTaxonomyDeleteResult>(
      EASY_EMAIL_HTTP_ROUTES.taxonomyItem(itemId),
      { expectedVersion },
    );
  }

  public async listMailAccounts(query: MailAccountListQuery = {}): Promise<MailAccountListResult> {
    return this.httpClient.get<MailAccountListResult>(EASY_EMAIL_HTTP_ROUTES.accounts, {
      scope: query.scope,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async getMailAccount(accountId: string): Promise<MailAccount> {
    const response = await this.httpClient.get<{ account: MailAccount }>(EASY_EMAIL_HTTP_ROUTES.account(accountId));
    return response.account;
  }

  public async createMailAccount(input: MailAccountCreateInput): Promise<MailAccount> {
    const response = await this.httpClient.post<MailAccountCreateInput, { account: MailAccount }>(EASY_EMAIL_HTTP_ROUTES.accounts, input);
    return response.account;
  }

  public async updateMailAccount(accountId: string, input: MailAccountUpdateInput): Promise<MailAccount> {
    const response = await this.httpClient.patch<MailAccountUpdateInput, { account: MailAccount }>(EASY_EMAIL_HTTP_ROUTES.account(accountId), input);
    return response.account;
  }

  public async disableMailAccount(accountId: string, expectedVersion: number): Promise<MailAccount> {
    const response = await this.httpClient.post<{ expectedVersion: number }, { account: MailAccount }>(EASY_EMAIL_HTTP_ROUTES.disableAccount(accountId), { expectedVersion });
    return response.account;
  }

  public async deleteMailAccount(accountId: string, expectedVersion: number): Promise<{ id: string }> {
    const response = await this.httpClient.delete<{ deleted: { id: string } }>(EASY_EMAIL_HTTP_ROUTES.account(accountId), { expectedVersion });
    return response.deleted;
  }

  public async testMailAccountImap(
    input: MailAccountImapTestRequest,
  ): Promise<MailAccountImapTestResult> {
    const response = await this.httpClient.post<
      MailAccountImapTestRequest,
      { result: MailAccountImapTestResult }
    >(EASY_EMAIL_HTTP_ROUTES.testAccountImap, input);
    return response.result;
  }

  public async planMailbox(request: VerificationMailboxRequest): Promise<MailboxPlanResult> {
    const response = await this.httpClient.post<VerificationMailboxRequest, { plan: MailboxPlanResult }>(
      EASY_EMAIL_HTTP_ROUTES.planMailbox,
      request,
    );
    return response.plan;
  }

  public async openMailbox(request: VerificationMailboxRequest): Promise<VerificationMailboxOpenResult> {
    const response = await this.httpClient.post<VerificationMailboxRequest, { result: VerificationMailboxOpenResult }>(
      EASY_EMAIL_HTTP_ROUTES.openMailbox,
      request,
    );
    return response.result;
  }

  public async sendMailboxMessage(request: MailboxSendRequest): Promise<MailboxSendResult> {
    const response = await this.httpClient.post<MailboxSendRequest, { result: MailboxSendResult }>(
      EASY_EMAIL_HTTP_ROUTES.sendMailboxMessage,
      request,
    );
    return response.result;
  }

  public async updateMailboxSession(request: MailboxSessionUpdateRequest): Promise<MailboxSession> {
    const response = await this.httpClient.post<MailboxSessionUpdateRequest, { session: MailboxSession }>(
      EASY_EMAIL_HTTP_ROUTES.updateMailboxSession,
      request,
    );
    return response.session;
  }

  public async releaseMailbox(request: ReleaseMailboxRequest): Promise<ReleaseMailboxResult> {
    const response = await this.httpClient.post<ReleaseMailboxRequest, { result: ReleaseMailboxResult }>(
      EASY_EMAIL_HTTP_ROUTES.releaseMailbox,
      request,
    );
    return response.result;
  }

  public async recoverMailboxByEmail(request: RecoverMailboxByEmailRequest): Promise<RecoverMailboxByEmailResult> {
    const response = await this.httpClient.post<RecoverMailboxByEmailRequest, { result: RecoverMailboxByEmailResult }>(
      EASY_EMAIL_HTTP_ROUTES.recoverMailboxByEmail,
      request,
    );
    return response.result;
  }

  public async recoverMailboxCapacity(request: RecoverMailboxCapacityRequest): Promise<RecoverMailboxCapacityResult> {
    const response = await this.httpClient.post<RecoverMailboxCapacityRequest, { result: RecoverMailboxCapacityResult }>(
      EASY_EMAIL_HTTP_ROUTES.recoverMailboxCapacity,
      request,
    );
    return response.result;
  }

  public async readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined> {
    const response = await this.httpClient.get<{ code?: VerificationCodeResult }>(
      EASY_EMAIL_HTTP_ROUTES.readVerificationCode(sessionId),
    );
    return response.code;
  }

  public async readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined> {
    const response = await this.httpClient.get<{ authLink?: AuthenticationLinkResult }>(
      EASY_EMAIL_HTTP_ROUTES.readAuthenticationLink(sessionId),
    );
    return response.authLink;
  }

  public async reportMailboxOutcome(report: MailboxOutcomeReport): Promise<MailboxOutcomeReportResult> {
    const response = await this.httpClient.post<MailboxOutcomeReport, { result: MailboxOutcomeReportResult }>(
      EASY_EMAIL_HTTP_ROUTES.reportMailboxOutcome,
      report,
    );
    return response.result;
  }

  public async observeMessage(input: ObserveMessageInput): Promise<ObservedMessage> {
    const response = await this.httpClient.post<ObserveMessageInput, { message: ObservedMessage }>(
      EASY_EMAIL_HTTP_ROUTES.observeMessage,
      input,
    );
    return response.message;
  }

  public async listObservedMessages(filters: ObservedMessageQueryFilters = {}): Promise<ObservedMessage[]> {
    const response = await this.httpClient.get<{ messages: ObservedMessage[] }>(
      EASY_EMAIL_HTTP_ROUTES.queryObservedMessages,
      filters,
    );
    return response.messages;
  }

  public async getObservedMessage(messageId: string): Promise<ObservedMessage | undefined> {
    const response = await this.httpClient.get<{ message?: ObservedMessage }>(
      EASY_EMAIL_HTTP_ROUTES.getObservedMessage(messageId),
    );
    return response.message;
  }
}
