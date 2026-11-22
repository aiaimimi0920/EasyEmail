import type * as Contracts from "./contracts.js";
import { refreshMailboxSessions } from "./mailbox-refresh-support.js";
import { EasyEmailError } from "../domain/errors.js";
import type { MailTaxonomyKind } from "../domain/mail-taxonomy.js";
import type { MailStateQueryRepository } from "../persistence/contracts.js";
import {
  calculateMailPersistenceStats,
  queryHostBindingsFromSnapshot,
  queryMailboxSessionsFromSnapshot,
  queryObservedMessagesFromSnapshot,
  queryProviderInstancesFromSnapshot,
} from "../persistence/query-helpers.js";
import type { MailAccountService } from "../service/accounts.js";
import type { ContactService } from "../service/contacts.js";
import { createEasyEmailService, type EasyEmailService } from "../service/easy-email-service.js";
import type { MailMessageService } from "../service/mail-messages.js";
import {
  MAIL_TAXONOMY_CAPABILITIES,
  type MailTaxonomyService,
} from "../service/mail-taxonomy.js";
import type { MailVerificationService } from "../service/mail-verifications.js";

export class EasyEmailHttpHandler {
  public constructor(
    private readonly service: EasyEmailService = createEasyEmailService(),
    private readonly queryRepository?: MailStateQueryRepository,
    private readonly contacts?: ContactService,
    private readonly mailTaxonomy?: MailTaxonomyService,
    private readonly accounts?: MailAccountService,
    private readonly messages?: MailMessageService,
    private readonly verifications?: MailVerificationService,
  ) {}

  private requireContacts(): ContactService {
    if (!this.contacts) {
      throw new EasyEmailError(
        "CONTACTS_PERSISTENCE_UNAVAILABLE",
        "Persistent contacts are not available in this runtime.",
      );
    }
    return this.contacts;
  }

  private requireMailTaxonomy(): MailTaxonomyService {
    if (!this.mailTaxonomy) {
      throw new EasyEmailError(
        "MAIL_TAXONOMY_PERSISTENCE_UNAVAILABLE",
        "Persistent mail taxonomy is not available in this runtime.",
      );
    }
    return this.mailTaxonomy;
  }

  private requireAccounts(): MailAccountService {
    if (!this.accounts) {
      throw new EasyEmailError(
        "ACCOUNTS_PERSISTENCE_UNAVAILABLE",
        "Persistent accounts are not available in this runtime.",
      );
    }
    return this.accounts;
  }

  private requireMessages(): MailMessageService {
    if (!this.messages) {
      throw new EasyEmailError(
        "MESSAGES_PERSISTENCE_UNAVAILABLE",
        "Persistent mail messages are not available in this runtime.",
      );
    }
    return this.messages;
  }

  private requireVerifications(): MailVerificationService {
    if (!this.verifications) {
      throw new EasyEmailError(
        "VERIFICATIONS_PERSISTENCE_UNAVAILABLE",
        "Persistent verification records are not available in this runtime.",
      );
    }
    return this.verifications;
  }

  public getCatalog(): Contracts.GetMailCatalogHttpResponse {
    return { catalog: this.service.getCatalog() };
  }

  public getSnapshot(): Contracts.GetMailSnapshotHttpResponse {
    return { snapshot: this.service.getSnapshot() };
  }

  public async registerCloudflareTempEmailRuntime(
    request: Contracts.RegisterCloudflareTempEmailRuntimeHttpRequest,
  ): Promise<Contracts.RegisterCloudflareTempEmailRuntimeHttpResponse> {
    return { result: await this.service.registerCloudflareTempEmailRuntime(request) };
  }

  public applyCredentialSets(
    request: Contracts.ApplyMailCredentialSetsHttpRequest,
  ): Contracts.ApplyMailCredentialSetsHttpResponse {
    return {
      result: this.service.applyCredentialSets(
        request.providerInstanceId,
        request.credentialSets,
      ),
    };
  }

  public async probeProviderInstance(
    instanceId: string,
  ): Promise<Contracts.ProbeProviderInstanceHttpResponse> {
    return { probe: await this.service.probeProviderInstance(instanceId) };
  }

  public async probeAllProviderInstances(): Promise<Contracts.ProbeAllProviderInstancesHttpResponse> {
    return { probes: await this.service.probeAllProviderInstances() };
  }

  public async queryProviderInstances(
    filters: Contracts.QueryProviderInstancesHttpRequest = {},
  ): Promise<Contracts.QueryProviderInstancesHttpResponse> {
    return {
      instances: queryProviderInstancesFromSnapshot(this.service.getSnapshot(), filters),
    };
  }

  public async queryHostBindings(
    filters: Contracts.QueryHostBindingsHttpRequest = {},
  ): Promise<Contracts.QueryHostBindingsHttpResponse> {
    return {
      bindings: this.queryRepository
        ? await this.queryRepository.listHostBindings(filters)
        : queryHostBindingsFromSnapshot(this.service.getSnapshot(), filters),
    };
  }

  public async queryMailboxSessions(
    filters: Contracts.QueryMailboxSessionsHttpRequest = {},
  ): Promise<Contracts.QueryMailboxSessionsHttpResponse> {
    return {
      sessions: this.queryRepository
        ? await this.queryRepository.listMailboxSessions(filters)
        : queryMailboxSessionsFromSnapshot(this.service.getSnapshot(), filters),
    };
  }

  public async queryObservedMessages(
    filters: Contracts.QueryObservedMessagesHttpRequest = {},
  ): Promise<Contracts.QueryObservedMessagesHttpResponse> {
    const synchronized = Boolean(filters.sync && filters.sessionId);
    if (synchronized) {
      await this.service.syncObservedMessages(filters.sessionId);
      await this.messages?.ingestObservedMessages();
    }
    const queryFilters = {
      ...filters,
      sync: undefined,
    };
    return {
      // A successful sync updates the registry before the periodic durable flush.
      messages: this.queryRepository && !synchronized
        ? await this.queryRepository.listObservedMessages(queryFilters)
        : queryObservedMessagesFromSnapshot(this.service.getSnapshot(), queryFilters),
    };
  }

  public getObservedMessage(messageId: string): Contracts.GetObservedMessageHttpResponse {
    return {
      message: this.service.getSnapshot().messages.find((item) => item.id === messageId),
    };
  }

  public async getPersistenceStats(): Promise<Contracts.GetMailPersistenceStatsHttpResponse> {
    return {
      stats: this.queryRepository
        ? await this.queryRepository.getStats()
        : calculateMailPersistenceStats(this.service.getSnapshot()),
    };
  }

  public planMailbox(request: Contracts.PlanMailboxHttpRequest): Contracts.PlanMailboxHttpResponse {
    return { plan: this.service.planMailbox(request) };
  }

  public async openMailbox(
    request: Contracts.OpenMailboxHttpRequest,
  ): Promise<Contracts.OpenMailboxHttpResponse> {
    return { result: await this.service.openMailbox(request) };
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

  public async refreshMailbox(sessionId: string): Promise<Contracts.RefreshMailboxHttpResponse> {
    const session = this.service.getSnapshot().sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${sessionId}.`);
    }
    const refresh = await refreshMailboxSessions(this.service, [session], false);
    await this.messages?.ingestObservedMessages();
    return { refresh };
  }

  public async refreshAnonymousMailboxes(
    request: Contracts.RefreshAnonymousMailboxesHttpRequest,
  ): Promise<Contracts.RefreshAnonymousMailboxesHttpResponse> {
    const hostId = request.hostId?.trim();
    if (!hostId) {
      throw new EasyEmailError("INVALID_QUERY", "hostId is required.");
    }
    const sessions = this.service.getSnapshot().sessions.filter((session) => session.hostId === hostId);
    const refresh = await refreshMailboxSessions(this.service, sessions, true);
    await this.messages?.ingestObservedMessages();
    return { refresh };
  }

  public async sendMailboxMessage(
    request: Contracts.SendMailboxMessageHttpRequest,
  ): Promise<Contracts.SendMailboxMessageHttpResponse> {
    return { result: await this.service.sendMailboxMessage(request) };
  }

  public updateMailboxSession(
    request: Contracts.UpdateMailboxSessionHttpRequest,
  ): Contracts.UpdateMailboxSessionHttpResponse {
    return {
      session: this.service.updateMailboxSession(request),
    };
  }

  public async releaseMailbox(
    request: Contracts.ReleaseMailboxHttpRequest,
  ): Promise<Contracts.ReleaseMailboxHttpResponse> {
    return { result: await this.service.releaseMailbox(request.sessionId, request.reason) };
  }

  public recoverMailboxByEmail(
    request: Contracts.RecoverMailboxByEmailHttpRequest,
  ): Promise<Contracts.RecoverMailboxByEmailHttpResponse> {
    return this.service.recoverMailboxSessionByEmailAddress({
      emailAddress: request.emailAddress,
      providerTypeKey: request.providerTypeKey,
      providerInstanceId: request.providerInstanceId,
      hostId: request.hostId,
      recoveryDataCredential: request.recoveryDataCredential,
      recoveryFields: request.recoveryFields,
    }).then((result) => ({
      result,
    }));
  }

  public async recoverMailboxCapacity(
    request: Contracts.RecoverMailboxCapacityHttpRequest,
  ): Promise<Contracts.RecoverMailboxCapacityHttpResponse> {
    return {
      result: await this.service.recoverMailboxCapacity({
        failureCode: request.failureCode,
        detail: request.detail,
        providerTypeKey: request.providerTypeKey,
        providerInstanceId: request.providerInstanceId,
        staleAfterSeconds: request.staleAfterSeconds,
        maxDeleteCount: request.maxDeleteCount,
        force: request.force,
      }),
    };
  }

  public async cleanupMoemailMailboxes(
    request: Contracts.CleanupMoemailMailboxesHttpRequest,
  ): Promise<Contracts.CleanupMoemailMailboxesHttpResponse> {
    return {
      result: await this.service.cleanupMoemailMailboxes(
        request.staleAfterSeconds,
        request.maxDeleteCount,
        request.force,
        request.providerInstanceId,
      ),
    };
  }

  public reportMailboxOutcome(
    request: Contracts.ReportMailboxOutcomeHttpRequest,
  ): Contracts.ReportMailboxOutcomeHttpResponse {
    return { result: this.service.reportMailboxOutcome(request) };
  }

  public async observeMessage(
    request: Contracts.ObserveMessageHttpRequest,
  ): Promise<Contracts.ObserveMessageHttpResponse> {
    const message = this.service.observeMessage(request);
    await this.messages?.ingestObservedMessages();
    return { message };
  }

  public async readVerificationCode(
    sessionId: string,
  ): Promise<Contracts.ReadVerificationCodeHttpResponse> {
    return { code: await this.service.readVerificationCode(sessionId) };
  }

  public async readAuthenticationLink(
    sessionId: string,
  ): Promise<Contracts.ReadAuthenticationLinkHttpResponse> {
    return { authLink: await this.service.readAuthenticationLink(sessionId) };
  }

  public runMaintenance(): Contracts.RunMaintenanceHttpResponse {
    return { maintenance: this.service.runMaintenance() };
  }
}
