import type {
  ApplyMailCredentialSetsHttpRequest,
  ApplyMailCredentialSetsHttpResponse,
  CleanupMoemailMailboxesHttpRequest,
  CleanupMoemailMailboxesHttpResponse,
  GetMailCatalogHttpResponse,
  GetObservedMessageHttpResponse,
  GetMailPersistenceStatsHttpResponse,
  GetMailSnapshotHttpResponse,
  ObserveMessageHttpRequest,
  ObserveMessageHttpResponse,
  OpenMailboxHttpRequest,
  OpenMailboxHttpResponse,
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
  ReadAuthenticationLinkHttpResponse,
  ReadVerificationCodeHttpResponse,
  RegisterCloudflareTempEmailRuntimeHttpRequest,
  RegisterCloudflareTempEmailRuntimeHttpResponse,
  ReportMailboxOutcomeHttpRequest,
  ReportMailboxOutcomeHttpResponse,
  RunMaintenanceHttpResponse,
} from "./contracts.js";
import { createEasyEmailService, type EasyEmailService } from "../service/easy-email-service.js";
import type { MailStateQueryRepository } from "../persistence/contracts.js";
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
  ) {}

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

  public async releaseMailbox(request: ReleaseMailboxHttpRequest): Promise<ReleaseMailboxHttpResponse> {
    return { result: await this.service.releaseMailbox(request.sessionId, request.reason) };
  }

  public recoverMailboxByEmail(
    request: RecoverMailboxByEmailHttpRequest,
  ): Promise<RecoverMailboxByEmailHttpResponse> {
    return this.service.recoverMailboxSessionByEmailAddress({
      emailAddress: request.emailAddress,
      providerTypeKey: request.providerTypeKey,
      hostId: request.hostId,
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
