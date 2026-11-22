import type * as Contracts from "./contracts.js";
import { refreshMailboxSessions } from "./mailbox-refresh-support.js";
import { EasyEmailError } from "../domain/errors.js";
import type { MailStateQueryRepository } from "../persistence/contracts.js";
import {
  calculateMailPersistenceStats,
  queryHostBindingsFromSnapshot,
  queryMailboxSessionsFromSnapshot,
  queryObservedMessagesFromSnapshot,
  queryProviderInstancesFromSnapshot,
} from "../persistence/query-helpers.js";
import { createEasyEmailService, type EasyEmailService } from "../service/easy-email-service.js";
import type { MailMessageService } from "../service/mail-messages.js";

export class EasyEmailCoreMailboxHttpHandler {
  public constructor(
    protected readonly service: EasyEmailService = createEasyEmailService(),
    protected readonly queryRepository?: MailStateQueryRepository,
    protected readonly messages?: MailMessageService,
  ) {}

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
