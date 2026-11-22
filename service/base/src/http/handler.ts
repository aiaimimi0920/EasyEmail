import type * as Contracts from "./contracts.js";
import { EasyEmailCoreMailboxHttpHandler } from "./handler-mailbox-core.js";
import { EasyEmailError } from "../domain/errors.js";
import type { MailTaxonomyKind } from "../domain/mail-taxonomy.js";
import type { MailStateQueryRepository } from "../persistence/contracts.js";
import type { MailAccountService } from "../service/accounts.js";
import type { ContactService } from "../service/contacts.js";
import { createEasyEmailService, type EasyEmailService } from "../service/easy-email-service.js";
import type { MailMessageService } from "../service/mail-messages.js";
import type { MailExtensionsService } from "../service/mail-extensions.js";
import type { MailImapService } from "../service/mail-imap-sync.js";
import type { MailPromotionService } from "../service/mail-promotion.js";
import type { MailSendQueueService } from "../service/mail-send-queue.js";
import {
  MAIL_TAXONOMY_CAPABILITIES,
  type MailTaxonomyService,
} from "../service/mail-taxonomy.js";
import type { MailVerificationService } from "../service/mail-verifications.js";

export class EasyEmailHttpHandler extends EasyEmailCoreMailboxHttpHandler {
  public constructor(
    service: EasyEmailService = createEasyEmailService(),
    queryRepository?: MailStateQueryRepository,
    private readonly contacts?: ContactService,
    private readonly mailTaxonomy?: MailTaxonomyService,
    private readonly accounts?: MailAccountService,
    messages?: MailMessageService,
    private readonly verifications?: MailVerificationService,
    private readonly sendQueue?: MailSendQueueService,
    private readonly imapSync?: MailImapService,
    private readonly mailPromotion?: MailPromotionService,
    private readonly mailExtensions?: MailExtensionsService,
  ) {
    super(service, queryRepository, messages);
  }

  protected requireContacts(): ContactService {
    if (!this.contacts) {
      throw new EasyEmailError(
        "CONTACTS_PERSISTENCE_UNAVAILABLE",
        "Persistent contacts are not available in this runtime.",
      );
    }
    return this.contacts;
  }

  protected requireMailTaxonomy(): MailTaxonomyService {
    if (!this.mailTaxonomy) {
      throw new EasyEmailError(
        "MAIL_TAXONOMY_PERSISTENCE_UNAVAILABLE",
        "Persistent mail taxonomy is not available in this runtime.",
      );
    }
    return this.mailTaxonomy;
  }

  protected requireAccounts(): MailAccountService {
    if (!this.accounts) {
      throw new EasyEmailError(
        "ACCOUNTS_PERSISTENCE_UNAVAILABLE",
        "Persistent accounts are not available in this runtime.",
      );
    }
    return this.accounts;
  }

  protected requireMessages(): MailMessageService {
    if (!this.messages) {
      throw new EasyEmailError(
        "MESSAGES_PERSISTENCE_UNAVAILABLE",
        "Persistent mail messages are not available in this runtime.",
      );
    }
    return this.messages;
  }

  protected requireVerifications(): MailVerificationService {
    if (!this.verifications) {
      throw new EasyEmailError(
        "VERIFICATIONS_PERSISTENCE_UNAVAILABLE",
        "Persistent verification records are not available in this runtime.",
      );
    }
    return this.verifications;
  }

  protected requireSendQueue(): MailSendQueueService {
    if (!this.sendQueue) {
      throw new EasyEmailError(
        "SEND_QUEUE_PERSISTENCE_UNAVAILABLE",
        "Persistent send queue is not available in this runtime.",
      );
    }
    return this.sendQueue;
  }

  protected requireImapSync(): MailImapService {
    if (!this.imapSync) {
      throw new EasyEmailError(
        "IMAP_SYNC_PERSISTENCE_UNAVAILABLE",
        "Persistent IMAP synchronization is not available in this runtime.",
      );
    }
    return this.imapSync;
  }

  protected requireMailPromotion(): MailPromotionService {
    if (!this.mailPromotion) {
      throw new EasyEmailError(
        "PROMOTION_PERSISTENCE_UNAVAILABLE",
        "Persistent mailbox promotion is not available in this runtime.",
      );
    }
    return this.mailPromotion;
  }

  protected requireMailExtensions(): MailExtensionsService {
    if (!this.mailExtensions) {
      throw new EasyEmailError(
        "EXTENSIONS_PERSISTENCE_UNAVAILABLE",
        "Persistent mail extensions are not available in this runtime.",
      );
    }
    return this.mailExtensions;
  }

  public async listContacts(
    request: Contracts.ListContactsHttpRequest = {},
  ): Promise<Contracts.ListContactsHttpResponse> {
    return this.requireContacts().listContacts(request);
  }

  public async getContact(contactId: string): Promise<Contracts.GetContactHttpResponse> {
    return { contact: await this.requireContacts().getContact(contactId) };
  }

  public async createContact(
    request: Contracts.CreateContactHttpRequest,
  ): Promise<Contracts.CreateContactHttpResponse> {
    return { contact: await this.requireContacts().createContact(request) };
  }

  public async updateContact(
    contactId: string,
    request: Contracts.UpdateContactHttpRequest,
  ): Promise<Contracts.UpdateContactHttpResponse> {
    return { contact: await this.requireContacts().updateContact(contactId, request) };
  }

  public async deleteContact(
    contactId: string,
    request: Contracts.DeleteContactHttpRequest,
  ): Promise<Contracts.DeleteContactHttpResponse> {
    return { deleted: await this.requireContacts().deleteContact(contactId, request) };
  }

  public async listMailAccounts(
    request: Contracts.ListMailAccountsHttpRequest = {},
  ): Promise<Contracts.ListMailAccountsHttpResponse> {
    return this.requireAccounts().listAccounts(request);
  }

  public async getMailAccount(accountId: string): Promise<Contracts.GetMailAccountHttpResponse> {
    return { account: await this.requireAccounts().getAccount(accountId) };
  }

  public async createMailAccount(
    request: Contracts.CreateMailAccountHttpRequest,
  ): Promise<Contracts.CreateMailAccountHttpResponse> {
    return { account: await this.requireAccounts().createAccount(request) };
  }

  public async updateMailAccount(
    accountId: string,
    request: Contracts.UpdateMailAccountHttpRequest,
  ): Promise<Contracts.UpdateMailAccountHttpResponse> {
    return { account: await this.requireAccounts().updateAccount(accountId, request) };
  }

  public async disableMailAccount(
    accountId: string,
    request: Contracts.DisableMailAccountHttpRequest,
  ): Promise<Contracts.DisableMailAccountHttpResponse> {
    return {
      account: await this.requireAccounts().disableAccount(accountId, request.expectedVersion),
    };
  }

  public async deleteMailAccount(
    accountId: string,
    request: Contracts.DeleteMailAccountHttpRequest,
  ): Promise<Contracts.DeleteMailAccountHttpResponse> {
    return { deleted: await this.requireAccounts().deleteAccount(accountId, request) };
  }

  public async testMailAccountImap(
    request: Contracts.TestMailAccountImapHttpRequest,
  ): Promise<Contracts.TestMailAccountImapHttpResponse> {
    return { result: await this.requireAccounts().testImapConnection(request) };
  }

  public async testMailAccountSmtp(
    request: Contracts.TestMailAccountSmtpHttpRequest,
  ): Promise<Contracts.TestMailAccountSmtpHttpResponse> {
    return { result: await this.requireAccounts().testSmtpConnection(request) };
  }

  public async listMailTaxonomy(
    request: Contracts.ListMailTaxonomyHttpRequest,
  ): Promise<Contracts.ListMailTaxonomyHttpResponse> {
    return this.requireMailTaxonomy().listItems(request);
  }

  public async getMailTaxonomy(itemId: string): Promise<Contracts.GetMailTaxonomyHttpResponse> {
    return {
      item: await this.requireMailTaxonomy().getItem(itemId),
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  public async upsertMailTaxonomy(
    kind: MailTaxonomyKind,
    key: string,
    request: Contracts.UpsertMailTaxonomyHttpRequest,
  ): Promise<Contracts.UpsertMailTaxonomyHttpResponse> {
    return {
      item: await this.requireMailTaxonomy().upsertItem(kind, key, request),
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  public async updateMailTaxonomy(
    itemId: string,
    request: Contracts.UpdateMailTaxonomyHttpRequest,
  ): Promise<Contracts.UpdateMailTaxonomyHttpResponse> {
    return {
      item: await this.requireMailTaxonomy().updateItem(itemId, request),
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  public async deleteMailTaxonomy(
    itemId: string,
    request: Contracts.DeleteMailTaxonomyHttpRequest,
  ): Promise<Contracts.DeleteMailTaxonomyHttpResponse> {
    return {
      deleted: await this.requireMailTaxonomy().deleteItem(itemId, request),
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  public async listMailMessages(
    request: Contracts.ListMailMessagesHttpRequest = {},
  ): Promise<Contracts.ListMailMessagesHttpResponse> {
    return this.requireMessages().listMessages(request);
  }

  public async getMailMessageDetail(
    messageId: string,
    request: Contracts.GetMailMessageDetailHttpRequest = {},
  ): Promise<Contracts.GetMailMessageDetailHttpResponse> {
    return { message: await this.requireMessages().getMessageDetail(messageId, request) };
  }

  public async saveLocalDraft(
    request: Contracts.SaveMailDraftHttpRequest,
  ): Promise<Contracts.SaveMailDraftHttpResponse> {
    return { draft: await this.requireMessages().saveLocalDraft(request) };
  }

  public async deleteLocalDraft(
    messageId: string,
  ): Promise<Contracts.MailMessageLocalActionHttpResponse> {
    return { action: await this.requireMessages().deleteLocalDraft(messageId) };
  }

  public async deleteMailMessageLocal(
    messageId: string,
  ): Promise<Contracts.MailMessageLocalActionHttpResponse> {
    return { action: await this.requireMessages().deleteLocal(messageId) };
  }

  public async deleteMailMessageForever(
    messageId: string,
  ): Promise<Contracts.MailMessageLocalActionHttpResponse> {
    return { action: await this.requireMessages().deleteForever(messageId) };
  }

  public async emptyMailTrash(
    request: Contracts.EmptyMailTrashHttpRequest = {},
  ): Promise<Contracts.EmptyMailTrashHttpResponse> {
    return { result: await this.requireMessages().emptyTrash(request) };
  }

  public async setMailMessageLocalFlag(
    messageId: string,
    request: Contracts.SetMailMessageFlagHttpRequest,
  ): Promise<Contracts.MailMessageLocalActionHttpResponse> {
    return { action: await this.requireMessages().setLocalFlag(messageId, request) };
  }

  public async setMailMessageLocalFolder(
    messageId: string,
    request: Contracts.SetMailMessageFolderHttpRequest,
  ): Promise<Contracts.MailMessageLocalActionHttpResponse> {
    return { action: await this.requireMessages().setLocalFolder(messageId, request) };
  }

  public async setMailMessageLocalLabel(
    messageId: string,
    request: Contracts.SetMailMessageLabelHttpRequest,
  ): Promise<Contracts.MailMessageLocalActionHttpResponse> {
    return { action: await this.requireMessages().setLocalLabel(messageId, request) };
  }

  public async listMailVerifications(
    request: Contracts.ListMailVerificationsHttpRequest = {},
  ): Promise<Contracts.ListMailVerificationsHttpResponse> {
    return { verifications: await this.requireVerifications().listVerifications(request) };
  }

  public async reclassifyMailMessageVerification(
    messageId: string,
  ): Promise<Contracts.ReclassifyMailMessageVerificationHttpResponse> {
    const verification = await this.requireVerifications().reclassifyMessage(messageId);
    return verification ? { verification } : {};
  }

  public async pollMailboxVerification(
    sessionId: string,
  ): Promise<Contracts.PollMailboxVerificationHttpResponse> {
    return this.requireVerifications().pollMailboxVerification(sessionId);
  }

  public async enqueueMailSend(
    request: Contracts.EnqueueMailSendHttpRequest,
    idempotencyKey?: string,
  ): Promise<Contracts.EnqueueMailSendHttpResponse> {
    return this.requireSendQueue().enqueueSend(request, idempotencyKey);
  }

  public async listMailSendQueue(
    request: Contracts.ListMailSendQueueHttpRequest = {},
  ): Promise<Contracts.ListMailSendQueueHttpResponse> {
    return this.requireSendQueue().listSendQueue(request);
  }

  public async getMailSendQueueItem(
    queueItemId: string,
  ): Promise<Contracts.GetMailSendQueueItemHttpResponse> {
    return { queueItem: await this.requireSendQueue().getSendQueueItem(queueItemId) };
  }

  public async runMailSendQueueItem(
    queueItemId: string,
  ): Promise<Contracts.RunMailSendQueueItemHttpResponse> {
    return this.requireSendQueue().runItem(queueItemId);
  }

  public async runMailSendQueueOnce(): Promise<Contracts.RunMailSendQueueWorkerHttpResponse> {
    return { runResult: await this.requireSendQueue().runOnce() };
  }

  public async runMailSendQueueDueBatch(
    request: Contracts.RunMailSendQueueDueBatchHttpRequest = {},
  ): Promise<Contracts.RunMailSendQueueWorkerHttpResponse> {
    return { runResult: await this.requireSendQueue().runDueBatch(request) };
  }

  public async cancelMailSendQueueItem(
    queueItemId: string,
    request: Contracts.CancelMailSendQueueItemHttpRequest = {},
  ): Promise<Contracts.CancelMailSendQueueItemHttpResponse> {
    return { queueItem: await this.requireSendQueue().cancelSendQueueItem(queueItemId, request) };
  }

  public async retryMailSendQueueItem(
    queueItemId: string,
    request: Contracts.RetryMailSendQueueItemHttpRequest = {},
  ): Promise<Contracts.RetryMailSendQueueItemHttpResponse> {
    return { queueItem: await this.requireSendQueue().retrySendQueueItem(queueItemId, request) };
  }

  public async reopenScheduledSend(
    messageId: string,
  ): Promise<Contracts.ReopenScheduledSendHttpResponse> {
    return this.requireSendQueue().reopenScheduledSend(messageId);
  }

  public async listMailAccountFolders(
    accountId: string,
    request: Contracts.ListMailAccountFoldersHttpRequest = {},
  ): Promise<Contracts.ListMailAccountFoldersHttpResponse> {
    return this.requireImapSync().listFolders(accountId, request);
  }

  public async getMailAccountSyncStatus(
    accountId: string,
  ): Promise<Contracts.GetMailAccountSyncStatusHttpResponse> {
    return { status: await this.requireImapSync().getSyncStatus(accountId) };
  }

  public async syncMailAccount(
    accountId: string,
    request: Contracts.SyncMailAccountHttpRequest = {},
  ): Promise<Contracts.SyncMailAccountHttpResponse> {
    return this.requireImapSync().syncAccount(accountId, request);
  }

  public async promoteMailboxSession(
    sessionId: string,
    request: Contracts.PromoteMailboxHttpRequest,
  ): Promise<Contracts.PromoteMailboxHttpResponse> {
    return this.requireMailPromotion().promoteMailboxSession(sessionId, request);
  }

  public async listNewsletterSubscriptions(
    request: Contracts.ListNewsletterSubscriptionsHttpRequest,
  ): Promise<Contracts.ListNewsletterSubscriptionsHttpResponse> {
    return {
      subscriptions: await this.requireMailExtensions().listNewsletterSubscriptions(request),
    };
  }

  public async setNewsletterSubscriptionHidden(
    subscriptionId: string,
    request: Contracts.UpdateNewsletterSubscriptionHttpRequest,
  ): Promise<Contracts.UpdateNewsletterSubscriptionHttpResponse> {
    return {
      action: await this.requireMailExtensions().setNewsletterSubscriptionHidden(
        subscriptionId,
        request,
      ),
    };
  }

  public async getEasyEmailSettings(): Promise<Contracts.GetEasyEmailSettingsHttpResponse> {
    return {
      settings: await this.requireMailExtensions().getEasyEmailSettings(),
    };
  }

  public async updateEasyEmailSettings(
    request: Contracts.UpdateEasyEmailSettingsHttpRequest,
  ): Promise<Contracts.UpdateEasyEmailSettingsHttpResponse> {
    return {
      settings: await this.requireMailExtensions().updateEasyEmailSettings(request),
    };
  }

  public async testEasyEmailConnection(
    request: Contracts.TestEasyEmailConnectionHttpRequest = {},
  ): Promise<Contracts.TestEasyEmailConnectionHttpResponse> {
    return {
      health: await this.requireMailExtensions().testEasyEmailConnection(request),
    };
  }
}
