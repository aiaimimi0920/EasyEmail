import type * as Contracts from "./contracts.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  createFetchJsonHttpClient,
} from "./http-transport.js";
import type {
  FetchJsonHttpClientOptions,
  JsonHttpClient,
} from "./http-transport.js";

export interface EasyEmailClientApi {
  getCatalog(): Promise<Contracts.EasyEmailCatalog>;
  getSnapshot(): Promise<Contracts.EasyEmailSnapshot>;
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
  listMailMessages(query?: Contracts.MailMessageListQuery): Promise<Contracts.MailMessageListResult>;
  getMailMessageDetail(
    messageId: string,
    query?: Contracts.MailMessageDetailQuery,
  ): Promise<Contracts.MailMessageDetail>;
  saveLocalDraft(input: Contracts.MailDraftSaveInput): Promise<Contracts.MailDraftSaveResult>;
  deleteLocalDraft(messageId: string): Promise<Contracts.MailMessageLocalActionResult>;
  deleteMailMessageLocal(messageId: string): Promise<Contracts.MailMessageLocalActionResult>;
  deleteMailMessageForever(messageId: string): Promise<Contracts.MailMessageLocalActionResult>;
  emptyMailTrash(input?: Contracts.MailTrashEmptyInput): Promise<Contracts.MailMessageBatchActionResult>;
  setMailMessageLocalFlag(
    messageId: string,
    input: Contracts.MailMessageSetFlagInput,
  ): Promise<Contracts.MailMessageLocalActionResult>;
  setMailMessageLocalFolder(
    messageId: string,
    input: Contracts.MailMessageSetFolderInput,
  ): Promise<Contracts.MailMessageLocalActionResult>;
  setMailMessageLocalLabel(
    messageId: string,
    input: Contracts.MailMessageSetLabelInput,
  ): Promise<Contracts.MailMessageLocalActionResult>;
  listMailVerifications(
    query?: Contracts.MailVerificationListQuery,
  ): Promise<Contracts.MailVerificationRecord[]>;
  reclassifyMailMessageVerification(
    messageId: string,
  ): Promise<Contracts.MailVerificationRecord | undefined>;
  pollMailboxVerification(sessionId: string): Promise<Contracts.PollMailboxVerificationResult>;
  planMailbox(request: Contracts.VerificationMailboxRequest): Promise<Contracts.MailboxPlanResult>;
  openMailbox(request: Contracts.VerificationMailboxRequest): Promise<Contracts.VerificationMailboxOpenResult>;
  sendMailboxMessage(request: Contracts.MailboxSendRequest): Promise<Contracts.MailboxSendResult>;
  updateMailboxSession(request: Contracts.MailboxSessionUpdateRequest): Promise<Contracts.MailboxSession>;
  releaseMailbox(request: Contracts.ReleaseMailboxRequest): Promise<Contracts.ReleaseMailboxResult>;
  recoverMailboxByEmail(request: Contracts.RecoverMailboxByEmailRequest): Promise<Contracts.RecoverMailboxByEmailResult>;
  recoverMailboxCapacity(request: Contracts.RecoverMailboxCapacityRequest): Promise<Contracts.RecoverMailboxCapacityResult>;
  readVerificationCode(sessionId: string): Promise<Contracts.VerificationCodeResult | undefined>;
  readAuthenticationLink(sessionId: string): Promise<Contracts.AuthenticationLinkResult | undefined>;
  reportMailboxOutcome(report: Contracts.MailboxOutcomeReport): Promise<Contracts.MailboxOutcomeReportResult>;
  observeMessage(input: Contracts.ObserveMessageInput): Promise<Contracts.ObservedMessage>;
  listObservedMessages(filters?: Contracts.ObservedMessageQueryFilters): Promise<Contracts.ObservedMessage[]>;
  getObservedMessage(messageId: string): Promise<Contracts.ObservedMessage | undefined>;
}

export class EasyEmailClient implements EasyEmailClientApi {
  private readonly httpClient: JsonHttpClient;

  public constructor(options: FetchJsonHttpClientOptions | JsonHttpClient) {
    this.httpClient = "baseUrl" in options
      ? createFetchJsonHttpClient(options)
      : options;
  }

  public async getCatalog(): Promise<Contracts.EasyEmailCatalog> {
    const response = await this.httpClient.get<{ catalog: Contracts.EasyEmailCatalog }>(
      EASY_EMAIL_HTTP_ROUTES.catalog,
    );
    return response.catalog;
  }

  public async getSnapshot(): Promise<Contracts.EasyEmailSnapshot> {
    const response = await this.httpClient.get<{ snapshot: Contracts.EasyEmailSnapshot }>(
      EASY_EMAIL_HTTP_ROUTES.snapshot,
    );
    return response.snapshot;
  }

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

  public async listMailMessages(
    query: Contracts.MailMessageListQuery = {},
  ): Promise<Contracts.MailMessageListResult> {
    return this.httpClient.get<Contracts.MailMessageListResult>(EASY_EMAIL_HTTP_ROUTES.messages, {
      scope: query.scope,
      accountId: query.accountId,
      sessionId: query.sessionId,
      folder: query.folder,
      label: query.label,
      search: query.search,
      includeArchived: query.includeArchived,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async getMailMessageDetail(
    messageId: string,
    query: Contracts.MailMessageDetailQuery = {},
  ): Promise<Contracts.MailMessageDetail> {
    const response = await this.httpClient.get<{ message: Contracts.MailMessageDetail }>(
      EASY_EMAIL_HTTP_ROUTES.message(messageId),
      {
        scope: query.scope,
        includeRawHtml: query.includeRawHtml,
      },
    );
    return response.message;
  }

  public async saveLocalDraft(
    input: Contracts.MailDraftSaveInput,
  ): Promise<Contracts.MailDraftSaveResult> {
    const response = await this.httpClient.post<
      Contracts.MailDraftSaveInput,
      { draft: Contracts.MailDraftSaveResult }
    >(EASY_EMAIL_HTTP_ROUTES.drafts, input);
    return response.draft;
  }

  public async deleteLocalDraft(messageId: string): Promise<Contracts.MailMessageLocalActionResult> {
    const response = await this.httpClient.delete<{ action: Contracts.MailMessageLocalActionResult }>(
      EASY_EMAIL_HTTP_ROUTES.draft(messageId),
    );
    return response.action;
  }

  public async deleteMailMessageLocal(
    messageId: string,
  ): Promise<Contracts.MailMessageLocalActionResult> {
    const response = await this.httpClient.delete<{ action: Contracts.MailMessageLocalActionResult }>(
      EASY_EMAIL_HTTP_ROUTES.messageLocal(messageId),
    );
    return response.action;
  }

  public async deleteMailMessageForever(
    messageId: string,
  ): Promise<Contracts.MailMessageLocalActionResult> {
    const response = await this.httpClient.delete<{ action: Contracts.MailMessageLocalActionResult }>(
      EASY_EMAIL_HTTP_ROUTES.message(messageId),
    );
    return response.action;
  }

  public async emptyMailTrash(
    input: Contracts.MailTrashEmptyInput = {},
  ): Promise<Contracts.MailMessageBatchActionResult> {
    const response = await this.httpClient.delete<{ result: Contracts.MailMessageBatchActionResult }>(
      EASY_EMAIL_HTTP_ROUTES.trash,
      undefined,
      input,
    );
    return response.result;
  }

  public async setMailMessageLocalFlag(
    messageId: string,
    input: Contracts.MailMessageSetFlagInput,
  ): Promise<Contracts.MailMessageLocalActionResult> {
    const response = await this.httpClient.patch<
      Contracts.MailMessageSetFlagInput,
      { action: Contracts.MailMessageLocalActionResult }
    >(EASY_EMAIL_HTTP_ROUTES.messageFlags(messageId), input);
    return response.action;
  }

  public async setMailMessageLocalFolder(
    messageId: string,
    input: Contracts.MailMessageSetFolderInput,
  ): Promise<Contracts.MailMessageLocalActionResult> {
    const response = await this.httpClient.patch<
      Contracts.MailMessageSetFolderInput,
      { action: Contracts.MailMessageLocalActionResult }
    >(EASY_EMAIL_HTTP_ROUTES.messageFolder(messageId), input);
    return response.action;
  }

  public async setMailMessageLocalLabel(
    messageId: string,
    input: Contracts.MailMessageSetLabelInput,
  ): Promise<Contracts.MailMessageLocalActionResult> {
    const response = await this.httpClient.patch<
      Contracts.MailMessageSetLabelInput,
      { action: Contracts.MailMessageLocalActionResult }
    >(EASY_EMAIL_HTTP_ROUTES.messageLabels(messageId), input);
    return response.action;
  }

  public async listMailVerifications(
    query: Contracts.MailVerificationListQuery = {},
  ): Promise<Contracts.MailVerificationRecord[]> {
    const response = await this.httpClient.get<{ verifications: Contracts.MailVerificationRecord[] }>(
      EASY_EMAIL_HTTP_ROUTES.verifications,
      {
        sessionId: query.sessionId,
        scope: query.scope,
        freshOnly: query.freshOnly,
        limit: query.limit,
      },
    );
    return response.verifications;
  }

  public async reclassifyMailMessageVerification(
    messageId: string,
  ): Promise<Contracts.MailVerificationRecord | undefined> {
    const response = await this.httpClient.post<
      Record<string, never>,
      { verification?: Contracts.MailVerificationRecord }
    >(EASY_EMAIL_HTTP_ROUTES.reclassifyMessageVerification(messageId), {});
    return response.verification;
  }

  public async pollMailboxVerification(
    sessionId: string,
  ): Promise<Contracts.PollMailboxVerificationResult> {
    return this.httpClient.post<Record<string, never>, Contracts.PollMailboxVerificationResult>(
      EASY_EMAIL_HTTP_ROUTES.pollMailboxVerification(sessionId),
      {},
    );
  }

  public async planMailbox(
    request: Contracts.VerificationMailboxRequest,
  ): Promise<Contracts.MailboxPlanResult> {
    const response = await this.httpClient.post<
      Contracts.VerificationMailboxRequest,
      { plan: Contracts.MailboxPlanResult }
    >(EASY_EMAIL_HTTP_ROUTES.planMailbox, request);
    return response.plan;
  }

  public async openMailbox(
    request: Contracts.VerificationMailboxRequest,
  ): Promise<Contracts.VerificationMailboxOpenResult> {
    const response = await this.httpClient.post<
      Contracts.VerificationMailboxRequest,
      { result: Contracts.VerificationMailboxOpenResult }
    >(EASY_EMAIL_HTTP_ROUTES.openMailbox, request);
    return response.result;
  }

  public async sendMailboxMessage(
    request: Contracts.MailboxSendRequest,
  ): Promise<Contracts.MailboxSendResult> {
    const response = await this.httpClient.post<
      Contracts.MailboxSendRequest,
      { result: Contracts.MailboxSendResult }
    >(EASY_EMAIL_HTTP_ROUTES.sendMailboxMessage, request);
    return response.result;
  }

  public async updateMailboxSession(
    request: Contracts.MailboxSessionUpdateRequest,
  ): Promise<Contracts.MailboxSession> {
    const response = await this.httpClient.post<
      Contracts.MailboxSessionUpdateRequest,
      { session: Contracts.MailboxSession }
    >(EASY_EMAIL_HTTP_ROUTES.updateMailboxSession, request);
    return response.session;
  }

  public async releaseMailbox(
    request: Contracts.ReleaseMailboxRequest,
  ): Promise<Contracts.ReleaseMailboxResult> {
    const response = await this.httpClient.post<
      Contracts.ReleaseMailboxRequest,
      { result: Contracts.ReleaseMailboxResult }
    >(EASY_EMAIL_HTTP_ROUTES.releaseMailbox, request);
    return response.result;
  }

  public async recoverMailboxByEmail(
    request: Contracts.RecoverMailboxByEmailRequest,
  ): Promise<Contracts.RecoverMailboxByEmailResult> {
    const response = await this.httpClient.post<
      Contracts.RecoverMailboxByEmailRequest,
      { result: Contracts.RecoverMailboxByEmailResult }
    >(EASY_EMAIL_HTTP_ROUTES.recoverMailboxByEmail, request);
    return response.result;
  }

  public async recoverMailboxCapacity(
    request: Contracts.RecoverMailboxCapacityRequest,
  ): Promise<Contracts.RecoverMailboxCapacityResult> {
    const response = await this.httpClient.post<
      Contracts.RecoverMailboxCapacityRequest,
      { result: Contracts.RecoverMailboxCapacityResult }
    >(EASY_EMAIL_HTTP_ROUTES.recoverMailboxCapacity, request);
    return response.result;
  }

  public async readVerificationCode(
    sessionId: string,
  ): Promise<Contracts.VerificationCodeResult | undefined> {
    const response = await this.httpClient.get<{ code?: Contracts.VerificationCodeResult }>(
      EASY_EMAIL_HTTP_ROUTES.readVerificationCode(sessionId),
    );
    return response.code;
  }

  public async readAuthenticationLink(
    sessionId: string,
  ): Promise<Contracts.AuthenticationLinkResult | undefined> {
    const response = await this.httpClient.get<{ authLink?: Contracts.AuthenticationLinkResult }>(
      EASY_EMAIL_HTTP_ROUTES.readAuthenticationLink(sessionId),
    );
    return response.authLink;
  }

  public async reportMailboxOutcome(
    report: Contracts.MailboxOutcomeReport,
  ): Promise<Contracts.MailboxOutcomeReportResult> {
    const response = await this.httpClient.post<
      Contracts.MailboxOutcomeReport,
      { result: Contracts.MailboxOutcomeReportResult }
    >(EASY_EMAIL_HTTP_ROUTES.reportMailboxOutcome, report);
    return response.result;
  }

  public async observeMessage(input: Contracts.ObserveMessageInput): Promise<Contracts.ObservedMessage> {
    const response = await this.httpClient.post<
      Contracts.ObserveMessageInput,
      { message: Contracts.ObservedMessage }
    >(EASY_EMAIL_HTTP_ROUTES.observeMessage, input);
    return response.message;
  }

  public async listObservedMessages(
    filters: Contracts.ObservedMessageQueryFilters = {},
  ): Promise<Contracts.ObservedMessage[]> {
    const response = await this.httpClient.get<{ messages: Contracts.ObservedMessage[] }>(
      EASY_EMAIL_HTTP_ROUTES.queryObservedMessages,
      filters,
    );
    return response.messages;
  }

  public async getObservedMessage(messageId: string): Promise<Contracts.ObservedMessage | undefined> {
    const response = await this.httpClient.get<{ message?: Contracts.ObservedMessage }>(
      EASY_EMAIL_HTTP_ROUTES.getObservedMessage(messageId),
    );
    return response.message;
  }
}
