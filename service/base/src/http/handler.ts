import type * as Contracts from "./contracts.js";
import { EasyEmailDeliveryAndAgentHttpHandlerBase } from "./handler-delivery-agent-base.js";
import { EasyEmailError } from "../domain/errors.js";
import type { MailTaxonomyKind } from "../domain/mail-taxonomy.js";
import type { MailStateQueryRepository } from "../persistence/contracts.js";
import type { MailAccountService } from "../service/accounts.js";
import type { ContactService } from "../service/contacts.js";
import { createEasyEmailService, type EasyEmailService } from "../service/easy-email-service.js";
import type { MailAgentService } from "../service/mail-agent.js";
import type { MailAvatarService } from "../service/mail-avatar.js";
import type { MailExtensionsService } from "../service/mail-extensions.js";
import type { MailImapService } from "../service/mail-imap-sync.js";
import type { MailMessageService } from "../service/mail-messages.js";
import type { MailPromotionService } from "../service/mail-promotion.js";
import type { MailSendQueueService } from "../service/mail-send-queue.js";
import {
  MAIL_TAXONOMY_CAPABILITIES,
  type MailTaxonomyService,
} from "../service/mail-taxonomy.js";
import type { MailVerificationService } from "../service/mail-verifications.js";
import { OmnimailWorkbenchFacade } from "../service/omnimail-workbench-facade.js";

export class EasyEmailHttpHandler extends EasyEmailDeliveryAndAgentHttpHandlerBase {
  public readonly omnimail: OmnimailWorkbenchFacade;

  public constructor(
    service: EasyEmailService = createEasyEmailService(),
    queryRepository?: MailStateQueryRepository,
    private readonly contacts?: ContactService,
    private readonly mailTaxonomy?: MailTaxonomyService,
    private readonly accounts?: MailAccountService,
    messages?: MailMessageService,
    private readonly verifications?: MailVerificationService,
    sendQueue?: MailSendQueueService,
    imapSync?: MailImapService,
    mailPromotion?: MailPromotionService,
    mailExtensions?: MailExtensionsService,
    mailAgent?: MailAgentService,
    mailAvatar?: MailAvatarService,
    omnimail?: OmnimailWorkbenchFacade,
  ) {
    super(
      service,
      queryRepository,
      messages,
      sendQueue,
      imapSync,
      mailPromotion,
      mailExtensions,
      mailAgent,
      mailAvatar,
    );
    this.omnimail =
      omnimail ??
      new OmnimailWorkbenchFacade({
        getAccount: accounts ? (id) => accounts.getAccount(id) : undefined,
        listRecentMessages: async () => {
          if (!messages) return [];
          const res = await messages.listMessages({ limit: 100, includeArchived: true });
          return res.messages.map((m) => ({
            id: m.id,
            accountId: m.accountId ?? undefined,
            sender: m.fromAddress,
            subject: m.subject,
            bodySnippet: m.snippet,
            receivedAtMs: Date.parse(m.observedAt) || Date.now(),
            hasAttachments: m.hasAttachments,
          }));
        },
        applyMessageRuleAction: messages
          ? async (messageId, actions) => {
              let touched = false;
              if (actions.markRead) {
                await messages.setLocalFlag(messageId, { flagName: "read", enabled: true });
                touched = true;
              }
              if (actions.star) {
                await messages.setLocalFlag(messageId, { flagName: "starred", enabled: true });
                touched = true;
              }
              if (actions.addLabelIds) {
                for (const labelName of actions.addLabelIds) {
                  await messages.setLocalLabel(messageId, { labelName, enabled: true });
                  touched = true;
                }
              }
              if (actions.trash) {
                await messages.deleteLocal(messageId);
                touched = true;
              } else if (actions.archive) {
                await messages.setLocalFolder(messageId, { folderName: "archive" });
                touched = true;
              } else if (actions.moveToFolderId) {
                await messages.setLocalFolder(messageId, { folderName: actions.moveToFolderId });
                touched = true;
              }
              return touched;
            }
          : undefined,
      });
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
}
