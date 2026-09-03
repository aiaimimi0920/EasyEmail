import type { CredentialSetDefinition } from "../shared/index.js";
import { createDisabledMailAliasService, type MailAliasService } from "../alias/service.js";
import {
  createDefaultEasyEmailProviderAdapters,
  createEasyEmailRegistryFromCatalog,
} from "./catalog.js";
import {
  openMailboxWithPlan,
  resolveMailboxOpenCandidateProviderTypeKeys,
  shouldFallbackMailboxOpen,
} from "./mailbox.js";
import {
  recordMailboxOpenFailure,
} from "./outcomes.js";
import {
  cleanupMailboxMessages,
  cleanupMailboxSessions,
  expireMailboxSessions,
  refreshInstanceHealth,
} from "../workers/index.js";
import {
  resetProviderOperationalState,
  synchronizeProviderOperationalState,
} from "./provider-operational-state.js";
import { EasyEmailError } from "../domain/errors.js";
import { MailRegistry } from "../domain/registry.js";
import {
  normalizeMailProviderTypeKey,
} from "../domain/models.js";
import { MailboxBindingService, MailboxDispatcher } from "../dispatch/index.js";
import type {
  AuthenticationLinkResult,
  MailboxSendRequest,
  MailboxSendResult,
  MailboxSessionUpdateRequest,
  HostBinding,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailBusinessStrategyId,
  MailProviderTypeKey,
  MailRoutingProfileDescriptor,
  MailStrategyModeResolution,
  EasyEmailCatalog,
  EasyEmailSnapshot,
  MailboxPlanResult,
  MailboxSession,
  ObserveMessageInput,
  ObservedMessage,
  ProviderCredentialBinding,
  ProviderCredentialSet,
  ProviderHealthProbeResult,
  ProviderInstance,
  ProviderTypeDefinition,
  RegisterCloudflareTempEmailRuntimeRequest,
  RegisterCloudflareTempEmailRuntimeResult,
  RuntimeTemplate,
  StrategyProfile,
  VerificationCodeResult,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "../domain/models.js";
import type {
  MailProviderAdapter,
} from "../providers/contracts.js";
import { createMailProviderAdapterMap } from "../providers/index.js";
import { CloudflareTempEmailRuntimeController } from "../providers/cloudflare_temp_email/control/index.js";
import { CloudflareTempEmailProvisioner } from "../providers/cloudflare_temp_email/provisioning/index.js";
import {
  createDefaultDispatchStrategyRegistry,
  type DispatchStrategyRegistry,
} from "../strategies/index.js";
import {
  mergeMailRoutingProfiles,
} from "../domain/strategy-mode.js";
import {
  attachMailboxOpenErrorContext,
  createAliasOutcomeSafely,
  isUnresolvedProviderPlanError,
  persistAliasOutcomeOnSession,
  planAliasSafely,
} from "./mailbox-open-support.js";
import { normalizeMailboxRequest } from "./mailbox-request-normalization.js";
import {
  cleanupMoemailMailboxes,
  inferMailboxCapacityRecoveryProviderType,
  type MailboxCapacityRecoveryInput,
  type MoemailMailboxCleanupResult,
} from "./moemail-mailbox-maintenance.js";
import { EasyEmailMessageOperations } from "./message-operations.js";
import {
  recoverMailboxSessionByEmailAddress,
  type MailboxSessionRecoveryInput,
  type MailboxSessionRecoveryResult,
} from "./mailbox-session-recovery.js";
import { EasyEmailProviderManagement } from "./provider-management.js";
import {
  releaseMailboxSession,
  type MailboxReleaseResult,
} from "./mailbox-release.js";

function createDefaultRegistry(now: Date = new Date()): MailRegistry {
  return createEasyEmailRegistryFromCatalog({}, now);
}

export interface EasyEmailServiceOptions {
  registry?: MailRegistry;
  strategies?: DispatchStrategyRegistry;
  adapters?: MailProviderAdapter[];
  strictProviderMode?: boolean;
  defaultStrategyMode?: MailStrategyModeResolution;
  routingProfiles?: MailRoutingProfileDescriptor[];
  aliasService?: MailAliasService;
}


export class EasyEmailService {
  private readonly adapterMap = new Map<MailProviderTypeKey, MailProviderAdapter>();

  private readonly bindings: MailboxBindingService;

  private readonly provisioner: CloudflareTempEmailProvisioner;

  private readonly runtimeController = new CloudflareTempEmailRuntimeController();

  private readonly dispatcher: MailboxDispatcher;
  private readonly routingProfiles: MailRoutingProfileDescriptor[];
  private readonly messageOperations: EasyEmailMessageOperations;
  private readonly providerManagement: EasyEmailProviderManagement;

  public constructor(
    private readonly registry: MailRegistry = createDefaultRegistry(),
    private readonly strategyRegistry: DispatchStrategyRegistry = createDefaultDispatchStrategyRegistry(),
    adapters: MailProviderAdapter[] = [],
    private readonly strictProviderMode = false,
    private readonly defaultStrategyMode?: MailStrategyModeResolution,
    routingProfiles: MailRoutingProfileDescriptor[] = [],
    private readonly aliasService: MailAliasService = createDisabledMailAliasService(),
  ) {
    this.adapterMap = createMailProviderAdapterMap(
      adapters.length > 0 ? adapters : createDefaultEasyEmailProviderAdapters(),
    );

    this.bindings = new MailboxBindingService(this.registry);
    this.provisioner = new CloudflareTempEmailProvisioner(this.registry);
    this.routingProfiles = mergeMailRoutingProfiles(routingProfiles);
    this.dispatcher = new MailboxDispatcher({
      registry: this.registry,
      bindings: this.bindings,
      provisioner: this.provisioner,
      runtimeController: this.runtimeController,
      strategyRegistry: this.strategyRegistry,
      defaultStrategyMode: this.defaultStrategyMode,
      routingProfiles: this.routingProfiles,
    });
    this.messageOperations = new EasyEmailMessageOperations(
      this.registry,
      this.adapterMap,
      (now) => this.syncOperationalState(now),
    );
    this.providerManagement = new EasyEmailProviderManagement(
      this.registry,
      this.adapterMap,
      this.provisioner,
      this.runtimeController,
      this.strictProviderMode,
      this.defaultStrategyMode,
      this.routingProfiles,
      (now) => this.syncOperationalState(now),
    );
  }

  public getCatalog(): EasyEmailCatalog {
    return this.providerManagement.getCatalog();
  }

  public saveProviderType(providerType: ProviderTypeDefinition): void {
    this.providerManagement.saveProviderType(providerType);
  }

  public saveProviderInstance(instance: ProviderInstance): void {
    this.providerManagement.saveProviderInstance(instance);
  }

  public saveStrategyProfile(profile: StrategyProfile): void {
    this.providerManagement.saveStrategyProfile(profile);
  }

  public saveRuntimeTemplate(template: RuntimeTemplate): void {
    this.providerManagement.saveRuntimeTemplate(template);
  }

  public saveCredentialSet(credentialSet: ProviderCredentialSet): void {
    this.providerManagement.saveCredentialSet(credentialSet);
  }

  public saveCredentialBinding(binding: ProviderCredentialBinding): void {
    this.providerManagement.saveCredentialBinding(binding);
  }

  public saveBinding(binding: HostBinding): void {
    this.providerManagement.saveBinding(binding);
  }

  public replaceCredentialBindingsForInstance(
    providerInstanceId: string,
    bindings: ProviderCredentialBinding[],
  ): void {
    this.providerManagement.replaceCredentialBindingsForInstance(providerInstanceId, bindings);
  }

  public applyCredentialSets(
    providerInstanceId: string,
    credentialSets: CredentialSetDefinition[],
    now: Date = new Date(),
  ): {
    instance: ProviderInstance;
    credentialSets: ProviderCredentialSet[];
    credentialBindings: ProviderCredentialBinding[];
  } {
    return this.providerManagement.applyCredentialSets(providerInstanceId, credentialSets, now);
  }

  public async registerCloudflareTempEmailRuntime(
    request: RegisterCloudflareTempEmailRuntimeRequest,
    now: Date = new Date(),
  ): Promise<RegisterCloudflareTempEmailRuntimeResult> {
    return await this.providerManagement.registerCloudflareTempEmailRuntime(request, now);
  }

  public async probeProviderInstance(
    instanceId: string,
    now: Date = new Date(),
  ): Promise<ProviderHealthProbeResult> {
    return await this.providerManagement.probeProviderInstance(instanceId, now);
  }

  public async probeAllProviderInstances(now: Date = new Date()): Promise<ProviderHealthProbeResult[]> {
    return await this.providerManagement.probeAllProviderInstances(now);
  }

  public planMailbox(request: VerificationMailboxRequest, now: Date = new Date()): MailboxPlanResult {
    this.syncOperationalState(now);
    const normalizedRequest = normalizeMailboxRequest(request, this.routingProfiles);
    return {
      ...this.dispatcher.resolveMailboxPlan(normalizedRequest, now, false),
      aliasPlan: planAliasSafely(this.aliasService, normalizedRequest),
    };
  }

  public async openMailbox(
    request: VerificationMailboxRequest,
    now: Date = new Date(),
  ): Promise<VerificationMailboxOpenResult> {
    this.syncOperationalState(now);
    const normalizedRequest = normalizeMailboxRequest(request, this.routingProfiles);
    const initialPlan = this.dispatcher.resolveMailboxPlan(normalizedRequest, now, true);
    const candidateProviderTypeKeys = resolveMailboxOpenCandidateProviderTypeKeys(initialPlan);
    let lastError: unknown;

    for (const providerTypeKey of candidateProviderTypeKeys) {
      let plan: MailboxPlanResult | undefined;

      try {
        plan = providerTypeKey === initialPlan.providerType.key
          ? initialPlan
          : this.dispatcher.resolveMailboxPlan(
            {
              ...normalizedRequest,
              providerTypeKey,
              strategyProfileId: normalizedRequest.strategyProfileId ?? initialPlan.strategyMode?.strategyProfileId,
            },
            now,
            true,
          );
        const opened = await openMailboxWithPlan({
          request: normalizedRequest,
          plan,
          now,
          registry: this.registry,
          bindings: this.bindings,
          adapterMap: this.adapterMap,
        });

        const aliasOutcome = await createAliasOutcomeSafely(this.aliasService, normalizedRequest, now);
        const session = persistAliasOutcomeOnSession(this.registry, opened.session, aliasOutcome);

        return {
          ...opened,
          session,
          aliasOutcome,
        };
      } catch (error) {
        const normalizedError = attachMailboxOpenErrorContext(error, plan, providerTypeKey);
        if (plan) {
          recordMailboxOpenFailure(this.registry, plan.instance, normalizedError, now);
        }
        this.syncOperationalState(now);
        if (
          !plan
          && lastError !== undefined
          && !normalizedRequest.providerTypeKey
          && isUnresolvedProviderPlanError(normalizedError)
        ) {
          continue;
        }
        lastError = normalizedError;
        if (!shouldFallbackMailboxOpen(request, initialPlan, providerTypeKey)) {
          throw normalizedError;
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new EasyEmailError(
      "PROVIDER_SELECTION_FAILED",
      "Unable to open a mailbox session for any eligible provider route.",
    );
  }

  public async releaseMailbox(
    sessionId: string,
    reason?: string,
    now: Date = new Date(),
  ): Promise<MailboxReleaseResult> {
    return await releaseMailboxSession({
      sessionId,
      reason,
      now,
      registry: this.registry,
      adapterMap: this.adapterMap,
      syncOperationalState: (at) => this.syncOperationalState(at),
    });
  }

  public async recoverMailboxCapacity(
    input: MailboxCapacityRecoveryInput,
    now: Date = new Date(),
  ): Promise<{
    ok: boolean;
    status: string;
    providerTypeKey?: MailProviderTypeKey;
    providerInstanceId?: string;
    action?: string;
    detail?: string;
    recovery?: unknown;
  }> {
    this.syncOperationalState(now);

    const detail = input.detail?.trim() || undefined;
    const failureCode = input.failureCode?.trim() || undefined;
    const providerTypeKey = inferMailboxCapacityRecoveryProviderType({
      providerTypeKey: input.providerTypeKey,
      failureCode,
      detail,
    });
    const providerInstanceId = input.providerInstanceId?.trim() || undefined;

    if (providerTypeKey === "moemail") {
      const recovery = await this.cleanupMoemailMailboxes(
        input.staleAfterSeconds,
        input.maxDeleteCount,
        input.force,
        providerInstanceId,
        now,
      );
      return {
        ok: true,
        status: "provider_capacity_recovery_finished",
        providerTypeKey,
        providerInstanceId: recovery.providerInstanceId,
        action: "cleanup_mailboxes",
        detail,
        recovery,
      };
    }

    return {
      ok: false,
      status: providerTypeKey
        ? "provider_capacity_recovery_not_supported"
        : "provider_capacity_recovery_not_needed",
      providerTypeKey,
      providerInstanceId,
      detail: detail || failureCode,
    };
  }

  public async cleanupMoemailMailboxes(
    staleAfterSeconds = 300,
    maxDeleteCount = 200,
    force = false,
    providerInstanceId?: string,
    now: Date = new Date(),
  ): Promise<MoemailMailboxCleanupResult> {
    this.syncOperationalState(now);
    return await cleanupMoemailMailboxes({
      registry: this.registry,
      getSnapshot: () => this.getSnapshot(),
      staleAfterSeconds,
      maxDeleteCount,
      force,
      providerInstanceId,
      now,
    });
  }

  public observeMessage(input: ObserveMessageInput, now: Date = new Date()): ObservedMessage {
    return this.messageOperations.observeMessage(input, now);
  }

  public async readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined> {
    return await this.messageOperations.readVerificationCode(sessionId);
  }

  public async readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined> {
    return await this.messageOperations.readAuthenticationLink(sessionId);
  }

  public async sendMailboxMessage(
    request: MailboxSendRequest,
    now: Date = new Date(),
  ): Promise<MailboxSendResult> {
    return await this.messageOperations.sendMailboxMessage(request, now);
  }

  public updateMailboxSession(request: MailboxSessionUpdateRequest): MailboxSession {
    return this.messageOperations.updateMailboxSession(request);
  }

  public async syncObservedMessages(sessionId: string): Promise<ObservedMessage[]> {
    return await this.messageOperations.syncObservedMessages(sessionId);
  }

  public reportMailboxOutcome(
    report: MailboxOutcomeReport,
    now: Date = new Date(),
  ): MailboxOutcomeReportResult {
    return this.messageOperations.reportMailboxOutcome(report, now);
  }

  public getSnapshot(): EasyEmailSnapshot {
    this.syncOperationalState();
    return this.registry.snapshot();
  }

  public listProviderTypes() {
    return this.registry.listProviderTypes();
  }

  public getProviderType(typeKey: MailProviderTypeKey) {
    return this.registry.getProviderType(normalizeMailProviderTypeKey(typeKey) ?? typeKey);
  }

  public listRuntimeTemplates() {
    return this.registry.listRuntimeTemplates();
  }

  public listInstances() {
    this.syncOperationalState();
    return this.registry.listInstances();
  }

  public findInstanceById(instanceId: string) {
    this.syncOperationalState();
    return this.registry.findInstanceById(instanceId);
  }

  public listBindings() {
    return this.registry.listBindings();
  }

  public listCredentialSets() {
    return this.registry.listCredentialSets();
  }

  public listCredentialBindings() {
    return this.registry.listCredentialBindings();
  }

  public listStrategies() {
    return this.registry.listStrategies();
  }

  public findMailboxSessionByEmailAddress(
    emailAddress: string,
    providerTypeKey?: MailProviderTypeKey,
  ) {
    this.syncOperationalState();
    return this.registry.findLatestSessionByEmailAddress(
      emailAddress,
      providerTypeKey ? (normalizeMailProviderTypeKey(providerTypeKey) ?? providerTypeKey) : undefined,
    );
  }

  public async recoverMailboxSessionByEmailAddress(
    input: MailboxSessionRecoveryInput,
    now: Date = new Date(),
  ): Promise<MailboxSessionRecoveryResult> {
    return await recoverMailboxSessionByEmailAddress({
      input,
      registry: this.registry,
      adapterMap: this.adapterMap,
      now,
      syncOperationalState: (at) => this.syncOperationalState(at),
    });
  }

  public expireSessions(now: Date = new Date()) {
    return expireMailboxSessions(this.registry, now);
  }

  public cleanupMessages(keepRecentCount?: number) {
    return cleanupMailboxMessages(this.registry, { keepRecentCount });
  }

  public cleanupSessions(keepRecentCount?: number) {
    return cleanupMailboxSessions(this.registry, { keepRecentCount });
  }

  public refreshHealth() {
    this.syncOperationalState();
    return refreshInstanceHealth(this.registry);
  }

  public runMaintenance(now: Date = new Date()) {
    this.syncOperationalState(now);
    return {
      expired: expireMailboxSessions(this.registry, now),
      cleanedSessions: cleanupMailboxSessions(this.registry),
      cleaned: cleanupMailboxMessages(this.registry),
      refreshed: refreshInstanceHealth(this.registry),
    };
  }

  public resetOperationalState(now: Date = new Date()) {
    return resetProviderOperationalState(this.registry, now);
  }

  private syncOperationalState(now: Date = new Date()): void {
    synchronizeProviderOperationalState(this.registry, now);
  }
}

export function createEasyEmailService(options: EasyEmailServiceOptions = {}): EasyEmailService {
  return new EasyEmailService(
    options.registry,
    options.strategies,
    options.adapters,
    options.strictProviderMode,
    options.defaultStrategyMode,
    options.routingProfiles,
    options.aliasService,
  );
}
