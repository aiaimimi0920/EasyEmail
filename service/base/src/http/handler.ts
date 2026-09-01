import type {
  ApplyMailCredentialSetsHttpRequest,
  ApplyMailCredentialSetsHttpResponse,
  CleanupMoemailMailboxesHttpRequest,
  CleanupMoemailMailboxesHttpResponse,
  CreateContactHttpRequest,
  CreateContactHttpResponse,
  DeleteContactHttpRequest,
  DeleteContactHttpResponse,
  DeleteMailTaxonomyHttpRequest,
  DeleteMailTaxonomyHttpResponse,
  GetContactHttpResponse,
  GetMailCatalogHttpResponse,
  GetMailTaxonomyHttpResponse,
  GetObservedMessageHttpResponse,
  GetMailPersistenceStatsHttpResponse,
  GetMailSnapshotHttpResponse,
  ListContactsHttpRequest,
  ListContactsHttpResponse,
  ListMailTaxonomyHttpRequest,
  ListMailTaxonomyHttpResponse,
  ObserveMessageHttpRequest,
  ObserveMessageHttpResponse,
  OpenMailboxHttpRequest,
  OpenMailboxHttpResponse,
  SendMailboxMessageHttpRequest,
  SendMailboxMessageHttpResponse,
  UpdateMailboxSessionHttpRequest,
  UpdateMailboxSessionHttpResponse,
  RecoverMailboxByEmailHttpRequest,
  RecoverMailboxByEmailHttpResponse,
  ReleaseMailboxHttpRequest,
  ReleaseMailboxHttpResponse,
  RecoverMailboxCapacityHttpRequest,
  RecoverMailboxCapacityHttpResponse,
  PlanMailboxHttpRequest,
  PlanMailboxHttpResponse,
  ProbeAllProviderInstancesHttpResponse,
  ProbeProviderInstanceHttpResponse,
  QueryHostBindingsHttpRequest,
  QueryHostBindingsHttpResponse,
  QueryMailboxSessionsHttpRequest,
  QueryMailboxSessionsHttpResponse,
  QueryObservedMessagesHttpRequest,
  QueryObservedMessagesHttpResponse,
  QueryProviderInstancesHttpRequest,
  QueryProviderInstancesHttpResponse,
  RefreshAnonymousMailboxesHttpRequest,
  RefreshAnonymousMailboxesHttpResponse,
  RefreshMailboxHttpResponse,
  MailboxRefreshResult,
  ReadAuthenticationLinkHttpResponse,
  ReadVerificationCodeHttpResponse,
  RegisterCloudflareTempEmailRuntimeHttpRequest,
  RegisterCloudflareTempEmailRuntimeHttpResponse,
  ReportMailboxOutcomeHttpRequest,
  ReportMailboxOutcomeHttpResponse,
  RunMaintenanceHttpResponse,
  UpdateContactHttpRequest,
  UpdateContactHttpResponse,
  UpdateMailTaxonomyHttpRequest,
  UpdateMailTaxonomyHttpResponse,
  UpsertMailTaxonomyHttpRequest,
  UpsertMailTaxonomyHttpResponse,
} from "./contracts.js";
import { EasyEmailError } from "../domain/errors.js";
import type { MailboxSession } from "../domain/models.js";
import { createEasyEmailService, type EasyEmailService } from "../service/easy-email-service.js";
import type { MailStateQueryRepository } from "../persistence/contracts.js";
import type { ContactService } from "../service/contacts.js";
import type { MailTaxonomyKind } from "../domain/mail-taxonomy.js";
import {
  MAIL_TAXONOMY_CAPABILITIES,
  type MailTaxonomyService,
} from "../service/mail-taxonomy.js";
import {
  calculateMailPersistenceStats,
  queryHostBindingsFromSnapshot,
  queryMailboxSessionsFromSnapshot,
  queryObservedMessagesFromSnapshot,
  queryProviderInstancesFromSnapshot,
} from "../persistence/query-helpers.js";

export class EasyEmailHttpHandler {
  public constructor(
    private readonly service: EasyEmailService = createEasyEmailService(),
    private readonly queryRepository?: MailStateQueryRepository,
    private readonly contacts?: ContactService,
    private readonly mailTaxonomy?: MailTaxonomyService,
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

  public getCatalog(): GetMailCatalogHttpResponse {
    return { catalog: this.service.getCatalog() };
  }

  public getSnapshot(): GetMailSnapshotHttpResponse {
    return { snapshot: this.service.getSnapshot() };
  }

  public async registerCloudflareTempEmailRuntime(
    request: RegisterCloudflareTempEmailRuntimeHttpRequest,
  ): Promise<RegisterCloudflareTempEmailRuntimeHttpResponse> {
    return { result: await this.service.registerCloudflareTempEmailRuntime(request) };
  }

  public applyCredentialSets(
    request: ApplyMailCredentialSetsHttpRequest,
  ): ApplyMailCredentialSetsHttpResponse {
    return { result: this.service.applyCredentialSets(request.providerInstanceId, request.credentialSets) };
  }

  public async probeProviderInstance(instanceId: string): Promise<ProbeProviderInstanceHttpResponse> {
    return { probe: await this.service.probeProviderInstance(instanceId) };
  }

  public async probeAllProviderInstances(): Promise<ProbeAllProviderInstancesHttpResponse> {
    return { probes: await this.service.probeAllProviderInstances() };
  }

  public async queryProviderInstances(
    filters: QueryProviderInstancesHttpRequest = {},
  ): Promise<QueryProviderInstancesHttpResponse> {
    return {
      instances: queryProviderInstancesFromSnapshot(this.service.getSnapshot(), filters),
    };
  }

  public async queryHostBindings(
    filters: QueryHostBindingsHttpRequest = {},
  ): Promise<QueryHostBindingsHttpResponse> {
    return {
      bindings: this.queryRepository
        ? await this.queryRepository.listHostBindings(filters)
        : queryHostBindingsFromSnapshot(this.service.getSnapshot(), filters),
    };
  }

  public async queryMailboxSessions(
    filters: QueryMailboxSessionsHttpRequest = {},
  ): Promise<QueryMailboxSessionsHttpResponse> {
    return {
      sessions: this.queryRepository
        ? await this.queryRepository.listMailboxSessions(filters)
        : queryMailboxSessionsFromSnapshot(this.service.getSnapshot(), filters),
    };
  }

  public async queryObservedMessages(
    filters: QueryObservedMessagesHttpRequest = {},
  ): Promise<QueryObservedMessagesHttpResponse> {
    if (filters.sync && filters.sessionId) {
      await this.service.syncObservedMessages(filters.sessionId);
    }
    const queryFilters = {
      ...filters,
      sync: undefined,
    };
    return {
      messages: this.queryRepository
        ? await this.queryRepository.listObservedMessages(queryFilters)
        : queryObservedMessagesFromSnapshot(this.service.getSnapshot(), queryFilters),
    };
  }

  public getObservedMessage(messageId: string): GetObservedMessageHttpResponse {
    return {
      message: this.service.getSnapshot().messages.find((item) => item.id === messageId),
    };
  }

  public async getPersistenceStats(): Promise<GetMailPersistenceStatsHttpResponse> {
    return {
      stats: this.queryRepository
        ? await this.queryRepository.getStats()
        : calculateMailPersistenceStats(this.service.getSnapshot()),
    };
  }

  public planMailbox(request: PlanMailboxHttpRequest): PlanMailboxHttpResponse {
    return { plan: this.service.planMailbox(request) };
  }

  public async openMailbox(request: OpenMailboxHttpRequest): Promise<OpenMailboxHttpResponse> {
    return { result: await this.service.openMailbox(request) };
  }

  public async listContacts(
    request: ListContactsHttpRequest = {},
  ): Promise<ListContactsHttpResponse> {
    return this.requireContacts().listContacts(request);
  }

  public async getContact(contactId: string): Promise<GetContactHttpResponse> {
    return { contact: await this.requireContacts().getContact(contactId) };
  }

  public async createContact(request: CreateContactHttpRequest): Promise<CreateContactHttpResponse> {
    return { contact: await this.requireContacts().createContact(request) };
  }

  public async updateContact(
    contactId: string,
    request: UpdateContactHttpRequest,
  ): Promise<UpdateContactHttpResponse> {
    return { contact: await this.requireContacts().updateContact(contactId, request) };
  }

  public async deleteContact(
    contactId: string,
    request: DeleteContactHttpRequest,
  ): Promise<DeleteContactHttpResponse> {
    return { deleted: await this.requireContacts().deleteContact(contactId, request) };
  }

  public async listMailTaxonomy(
    request: ListMailTaxonomyHttpRequest,
  ): Promise<ListMailTaxonomyHttpResponse> {
    return this.requireMailTaxonomy().listItems(request);
  }

  public async getMailTaxonomy(itemId: string): Promise<GetMailTaxonomyHttpResponse> {
    return {
      item: await this.requireMailTaxonomy().getItem(itemId),
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  public async upsertMailTaxonomy(
    kind: MailTaxonomyKind,
    key: string,
    request: UpsertMailTaxonomyHttpRequest,
  ): Promise<UpsertMailTaxonomyHttpResponse> {
    return {
      item: await this.requireMailTaxonomy().upsertItem(kind, key, request),
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  public async updateMailTaxonomy(
    itemId: string,
    request: UpdateMailTaxonomyHttpRequest,
  ): Promise<UpdateMailTaxonomyHttpResponse> {
    return {
      item: await this.requireMailTaxonomy().updateItem(itemId, request),
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  public async deleteMailTaxonomy(
    itemId: string,
    request: DeleteMailTaxonomyHttpRequest,
  ): Promise<DeleteMailTaxonomyHttpResponse> {
    return {
      deleted: await this.requireMailTaxonomy().deleteItem(itemId, request),
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  private async refreshSessions(
    sessions: MailboxSession[],
    captureFailures: boolean,
  ): Promise<MailboxRefreshResult> {
    const refresh: MailboxRefreshResult = {
      fetchedCount: 0,
      insertedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      refreshedSessionIds: [],
      skippedSessionIds: [],
      failures: [],
    };

    for (const session of sessions) {
      if (session.status !== "open") {
        refresh.skippedCount += 1;
        refresh.skippedSessionIds.push(session.id);
        continue;
      }

      const beforeIds = new Set(
        this.service.getSnapshot().messages
          .filter((message) => message.sessionId === session.id)
          .map((message) => message.id),
      );
      try {
        const fetched = await this.service.syncObservedMessages(session.id);
        const insertedCount = this.service.getSnapshot().messages.filter(
          (message) => message.sessionId === session.id && !beforeIds.has(message.id),
        ).length;
        refresh.fetchedCount += fetched.length;
        refresh.insertedCount += insertedCount;
        refresh.refreshedSessionIds.push(session.id);
      } catch (error) {
        const errorCode = error instanceof EasyEmailError ? error.code : "MAILBOX_REFRESH_FAILED";
        if (!captureFailures) {
          throw new EasyEmailError(
            errorCode,
            `Unable to refresh mailbox session ${session.id}.`,
          );
        }
        refresh.failedCount += 1;
        refresh.failures.push({
          sessionId: session.id,
          errorCode,
        });
      }
    }

    return refresh;
  }

  public async refreshMailbox(sessionId: string): Promise<RefreshMailboxHttpResponse> {
    const session = this.service.getSnapshot().sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${sessionId}.`);
    }
    return { refresh: await this.refreshSessions([session], false) };
  }

  public async refreshAnonymousMailboxes(
    request: RefreshAnonymousMailboxesHttpRequest,
  ): Promise<RefreshAnonymousMailboxesHttpResponse> {
    const hostId = request.hostId?.trim();
    if (!hostId) {
      throw new EasyEmailError("INVALID_QUERY", "hostId is required.");
    }
    const sessions = this.service.getSnapshot().sessions.filter((session) => session.hostId === hostId);
    return { refresh: await this.refreshSessions(sessions, true) };
  }

  public async sendMailboxMessage(
    request: SendMailboxMessageHttpRequest,
  ): Promise<SendMailboxMessageHttpResponse> {
    return { result: await this.service.sendMailboxMessage(request) };
  }

  public updateMailboxSession(
    request: UpdateMailboxSessionHttpRequest,
  ): UpdateMailboxSessionHttpResponse {
    return {
      session: this.service.updateMailboxSession(request),
    };
  }

  public async releaseMailbox(request: ReleaseMailboxHttpRequest): Promise<ReleaseMailboxHttpResponse> {
    return { result: await this.service.releaseMailbox(request.sessionId, request.reason) };
  }

  public recoverMailboxByEmail(
    request: RecoverMailboxByEmailHttpRequest,
  ): Promise<RecoverMailboxByEmailHttpResponse> {
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
    request: RecoverMailboxCapacityHttpRequest,
  ): Promise<RecoverMailboxCapacityHttpResponse> {
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
    request: CleanupMoemailMailboxesHttpRequest,
  ): Promise<CleanupMoemailMailboxesHttpResponse> {
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
    request: ReportMailboxOutcomeHttpRequest,
  ): ReportMailboxOutcomeHttpResponse {
    return { result: this.service.reportMailboxOutcome(request) };
  }

  public observeMessage(request: ObserveMessageHttpRequest): ObserveMessageHttpResponse {
    return { message: this.service.observeMessage(request) };
  }

  public async readVerificationCode(sessionId: string): Promise<ReadVerificationCodeHttpResponse> {
    return { code: await this.service.readVerificationCode(sessionId) };
  }

  public async readAuthenticationLink(sessionId: string): Promise<ReadAuthenticationLinkHttpResponse> {
    return { authLink: await this.service.readAuthenticationLink(sessionId) };
  }

  public runMaintenance(): RunMaintenanceHttpResponse {
    return { maintenance: this.service.runMaintenance() };
  }
}
