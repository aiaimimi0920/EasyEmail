import type * as Contracts from "./contracts.js";
import {
  EasyEmailMailboxClientBase,
  type EasyEmailMailboxClientApi,
} from "./client-mailbox-base.js";
import { EASY_EMAIL_HTTP_ROUTES } from "./http-transport.js";

export interface EasyEmailClientApi extends EasyEmailMailboxClientApi {
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
  enqueueMailSend(input: Contracts.MailSendEnqueueInput, idempotencyKey?: string): Promise<Contracts.MailSendEnqueueResult>;
  listMailSendQueue(query?: Contracts.MailSendQueueListQuery): Promise<Contracts.MailSendQueueListResult>;
  getMailSendQueueItem(queueItemId: string): Promise<Contracts.MailSendQueueItem>;
  runMailSendQueueItem(queueItemId: string): Promise<Contracts.MailSendQueueRunItemResult>;
  runMailSendQueueOnce(): Promise<Contracts.MailSendQueueWorkerRunResult>;
  runMailSendQueueDueBatch(input?: Contracts.MailSendQueueRunBatchInput): Promise<Contracts.MailSendQueueWorkerRunResult>;
  cancelMailSendQueueItem(queueItemId: string, input?: Contracts.MailSendQueueCancelInput): Promise<Contracts.MailSendQueueItem>;
  retryMailSendQueueItem(queueItemId: string, input?: Contracts.MailSendQueueRetryInput): Promise<Contracts.MailSendQueueItem>;
  reopenScheduledSend(messageId: string): Promise<Contracts.MailScheduledSendReopenResult>;
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
}

export class EasyEmailClient extends EasyEmailMailboxClientBase implements EasyEmailClientApi {
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

  public async enqueueMailSend(
    input: Contracts.MailSendEnqueueInput,
    idempotencyKey?: string,
  ): Promise<Contracts.MailSendEnqueueResult> {
    const headers = idempotencyKey?.trim()
      ? { "Idempotency-Key": idempotencyKey.trim() }
      : undefined;
    return this.httpClient.post<
      Contracts.MailSendEnqueueInput,
      Contracts.MailSendEnqueueResult
    >(EASY_EMAIL_HTTP_ROUTES.sendQueue, input, headers);
  }

  public async listMailSendQueue(
    query: Contracts.MailSendQueueListQuery = {},
  ): Promise<Contracts.MailSendQueueListResult> {
    return this.httpClient.get<Contracts.MailSendQueueListResult>(
      EASY_EMAIL_HTTP_ROUTES.sendQueue,
      {
        accountId: query.accountId,
        status: query.status,
        limit: query.limit,
        cursor: query.cursor,
      },
    );
  }

  public async getMailSendQueueItem(queueItemId: string): Promise<Contracts.MailSendQueueItem> {
    const response = await this.httpClient.get<{ queueItem: Contracts.MailSendQueueItem }>(
      EASY_EMAIL_HTTP_ROUTES.sendQueueItem(queueItemId),
    );
    return response.queueItem;
  }

  public async runMailSendQueueItem(
    queueItemId: string,
  ): Promise<Contracts.MailSendQueueRunItemResult> {
    return this.httpClient.post<Record<string, never>, Contracts.MailSendQueueRunItemResult>(
      EASY_EMAIL_HTTP_ROUTES.runSendQueueItem(queueItemId),
      {},
    );
  }

  public async runMailSendQueueOnce(): Promise<Contracts.MailSendQueueWorkerRunResult> {
    const response = await this.httpClient.post<
      Record<string, never>,
      { runResult: Contracts.MailSendQueueWorkerRunResult }
    >(EASY_EMAIL_HTTP_ROUTES.sendQueueRunOnce, {});
    return response.runResult;
  }

  public async runMailSendQueueDueBatch(
    input: Contracts.MailSendQueueRunBatchInput = {},
  ): Promise<Contracts.MailSendQueueWorkerRunResult> {
    const response = await this.httpClient.post<
      Contracts.MailSendQueueRunBatchInput,
      { runResult: Contracts.MailSendQueueWorkerRunResult }
    >(EASY_EMAIL_HTTP_ROUTES.sendQueueRunDue, input);
    return response.runResult;
  }

  public async cancelMailSendQueueItem(
    queueItemId: string,
    input: Contracts.MailSendQueueCancelInput = {},
  ): Promise<Contracts.MailSendQueueItem> {
    const response = await this.httpClient.post<
      Contracts.MailSendQueueCancelInput,
      { queueItem: Contracts.MailSendQueueItem }
    >(EASY_EMAIL_HTTP_ROUTES.cancelSendQueueItem(queueItemId), input);
    return response.queueItem;
  }

  public async retryMailSendQueueItem(
    queueItemId: string,
    input: Contracts.MailSendQueueRetryInput = {},
  ): Promise<Contracts.MailSendQueueItem> {
    const response = await this.httpClient.post<
      Contracts.MailSendQueueRetryInput,
      { queueItem: Contracts.MailSendQueueItem }
    >(EASY_EMAIL_HTTP_ROUTES.retrySendQueueItem(queueItemId), input);
    return response.queueItem;
  }

  public async reopenScheduledSend(
    messageId: string,
  ): Promise<Contracts.MailScheduledSendReopenResult> {
    return this.httpClient.post<Record<string, never>, Contracts.MailScheduledSendReopenResult>(
      EASY_EMAIL_HTTP_ROUTES.reopenScheduledSend(messageId),
      {},
    );
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
}
