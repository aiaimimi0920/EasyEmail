import type * as Contracts from "./contracts.js";
import { EasyEmailCoreMailboxHttpHandler } from "./handler-mailbox-core.js";
import { EasyEmailError } from "../domain/errors.js";
import type { MailStateQueryRepository } from "../persistence/contracts.js";
import { createEasyEmailService, type EasyEmailService } from "../service/easy-email-service.js";
import type { MailAgentService } from "../service/mail-agent.js";
import type { MailExtensionsService } from "../service/mail-extensions.js";
import type { MailImapService } from "../service/mail-imap-sync.js";
import type { MailMessageService } from "../service/mail-messages.js";
import type { MailPromotionService } from "../service/mail-promotion.js";
import type { MailSendQueueService } from "../service/mail-send-queue.js";

export class EasyEmailDeliveryAndAgentHttpHandlerBase extends EasyEmailCoreMailboxHttpHandler {
  public constructor(
    service: EasyEmailService = createEasyEmailService(),
    queryRepository?: MailStateQueryRepository,
    messages?: MailMessageService,
    private readonly sendQueue?: MailSendQueueService,
    private readonly imapSync?: MailImapService,
    private readonly mailPromotion?: MailPromotionService,
    private readonly mailExtensions?: MailExtensionsService,
    private readonly mailAgent?: MailAgentService,
  ) {
    super(service, queryRepository, messages);
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

  protected requireMailAgent(): MailAgentService {
    if (!this.mailAgent) {
      throw new EasyEmailError(
        "AGENT_PERSISTENCE_UNAVAILABLE",
        "Persistent Agent Mail is not available in this runtime.",
      );
    }
    return this.mailAgent;
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

  public async createAgentMailAccount(
    request: Contracts.CreateAgentMailAccountHttpRequest,
  ): Promise<Contracts.CreateAgentMailAccountHttpResponse> {
    return { account: await this.requireMailAgent().createAgentAccount(request) };
  }

  public async listAgentMailAccounts(
    request: Contracts.ListAgentMailAccountsHttpRequest = {},
  ): Promise<Contracts.ListAgentMailAccountsHttpResponse> {
    return this.requireMailAgent().listAgentAccounts(request);
  }

  public async createAgentMailService(
    request: Contracts.CreateAgentMailServiceHttpRequest,
  ): Promise<Contracts.CreateAgentMailServiceHttpResponse> {
    return { service: await this.requireMailAgent().createAgentService(request) };
  }

  public async listAgentMailServices(): Promise<Contracts.ListAgentMailServicesHttpResponse> {
    return { services: await this.requireMailAgent().listAgentServices() };
  }

  public async sendAgentMailTask(
    request: Contracts.SendAgentMailTaskHttpRequest,
    idempotencyKey?: string,
  ): Promise<Contracts.SendAgentMailTaskHttpResponse> {
    return this.requireMailAgent().sendAgentTask(request, idempotencyKey);
  }

  public async listAgentMailThreads(
    request: Contracts.ListAgentMailThreadsHttpRequest = {},
  ): Promise<Contracts.ListAgentMailThreadsHttpResponse> {
    return { threads: await this.requireMailAgent().listAgentThreads(request) };
  }

  public async getAgentMailThreadDetail(
    threadId: string,
  ): Promise<Contracts.GetAgentMailThreadDetailHttpResponse> {
    return { detail: await this.requireMailAgent().getAgentThreadDetail(threadId) };
  }
}
