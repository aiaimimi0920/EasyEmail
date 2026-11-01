import type { CredentialSetDefinition } from "../shared/index.js";
import { createDisabledMailAliasService, type MailAliasService } from "../alias/service.js";
import {
  createDefaultEasyEmailProviderAdapters,
  createEasyEmailRegistryFromCatalog,
} from "./catalog.js";
import { synchronizeProviderOperationalState } from "./provider-operational-state.js";
import { MailRegistry } from "../domain/registry.js";
import { MailboxBindingService, MailboxDispatcher } from "../dispatch/index.js";
import type {
  AuthenticationLinkResult,
  EasyEmailCatalog,
  EasyEmailSnapshot,
  HostBinding,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxPlanResult,
  MailboxSendRequest,
  MailboxSendResult,
  MailboxSession,
  MailboxSessionUpdateRequest,
  MailProviderTypeKey,
  MailRoutingProfileDescriptor,
  MailStrategyModeResolution,
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
import type { MailProviderAdapter } from "../providers/contracts.js";
import { createMailProviderAdapterMap } from "../providers/index.js";
import { CloudflareTempEmailRuntimeController } from "../providers/cloudflare_temp_email/control/index.js";
import { CloudflareTempEmailProvisioner } from "../providers/cloudflare_temp_email/provisioning/index.js";
import {
  createDefaultDispatchStrategyRegistry,
  type DispatchStrategyRegistry,
} from "../strategies/index.js";
import { mergeMailRoutingProfiles } from "../domain/strategy-mode.js";
import {
  EasyEmailMailboxOperations,
  type MailboxCapacityRecoveryResult,
} from "./easy-email-mailbox-operations.js";
import { EasyEmailRegistryOperations } from "./easy-email-registry-operations.js";
import type {
  MailboxCapacityRecoveryInput,
  MoemailMailboxCleanupResult,
} from "./moemail-mailbox-maintenance.js";
import { EasyEmailMessageOperations } from "./message-operations.js";
import type {
  MailboxSessionRecoveryInput,
  MailboxSessionRecoveryResult,
} from "./mailbox-session-recovery.js";
import { EasyEmailProviderManagement } from "./provider-management.js";
import type { MailboxReleaseResult } from "./mailbox-release.js";

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
  private readonly mailboxOperations: EasyEmailMailboxOperations;
  private readonly registryOperations: EasyEmailRegistryOperations;

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
    this.registryOperations = new EasyEmailRegistryOperations({
      registry: this.registry,
      adapterMap: this.adapterMap,
      syncOperationalState: (now) => this.syncOperationalState(now),
    });
    this.mailboxOperations = new EasyEmailMailboxOperations({
      registry: this.registry,
      bindings: this.bindings,
      dispatcher: this.dispatcher,
      adapterMap: this.adapterMap,
      routingProfiles: this.routingProfiles,
      aliasService: this.aliasService,
      getSnapshot: () => this.getSnapshot(),
      syncOperationalState: (now) => this.syncOperationalState(now),
    });
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
    return this.mailboxOperations.planMailbox(request, now);
  }

  public async openMailbox(
    request: VerificationMailboxRequest,
    now: Date = new Date(),
  ): Promise<VerificationMailboxOpenResult> {
    return await this.mailboxOperations.openMailbox(request, now);
  }

  public async releaseMailbox(
    sessionId: string,
    reason?: string,
    now: Date = new Date(),
  ): Promise<MailboxReleaseResult> {
    return await this.mailboxOperations.releaseMailbox(sessionId, reason, now);
  }

  public async recoverMailboxCapacity(
    input: MailboxCapacityRecoveryInput,
    now: Date = new Date(),
  ): Promise<MailboxCapacityRecoveryResult> {
    return await this.mailboxOperations.recoverMailboxCapacity(input, now);
  }

  public async cleanupMoemailMailboxes(
    staleAfterSeconds = 300,
    maxDeleteCount = 200,
    force = false,
    providerInstanceId?: string,
    now: Date = new Date(),
  ): Promise<MoemailMailboxCleanupResult> {
    return await this.mailboxOperations.cleanupMoemailMailboxes(
      staleAfterSeconds,
      maxDeleteCount,
      force,
      providerInstanceId,
      now,
    );
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
    return this.registryOperations.getSnapshot();
  }

  public listProviderTypes() {
    return this.registryOperations.listProviderTypes();
  }

  public getProviderType(typeKey: MailProviderTypeKey) {
    return this.registryOperations.getProviderType(typeKey);
  }

  public listRuntimeTemplates() {
    return this.registryOperations.listRuntimeTemplates();
  }

  public listInstances() {
    return this.registryOperations.listInstances();
  }

  public findInstanceById(instanceId: string) {
    return this.registryOperations.findInstanceById(instanceId);
  }

  public listBindings() {
    return this.registryOperations.listBindings();
  }

  public listCredentialSets() {
    return this.registryOperations.listCredentialSets();
  }

  public listCredentialBindings() {
    return this.registryOperations.listCredentialBindings();
  }

  public listStrategies() {
    return this.registryOperations.listStrategies();
  }

  public findMailboxSessionByEmailAddress(
    emailAddress: string,
    providerTypeKey?: MailProviderTypeKey,
  ) {
    return this.registryOperations.findMailboxSessionByEmailAddress(emailAddress, providerTypeKey);
  }

  public async recoverMailboxSessionByEmailAddress(
    input: MailboxSessionRecoveryInput,
    now: Date = new Date(),
  ): Promise<MailboxSessionRecoveryResult> {
    return await this.registryOperations.recoverMailboxSessionByEmailAddress(input, now);
  }

  public expireSessions(now: Date = new Date()) {
    return this.registryOperations.expireSessions(now);
  }

  public cleanupMessages(keepRecentCount?: number) {
    return this.registryOperations.cleanupMessages(keepRecentCount);
  }

  public cleanupSessions(keepRecentCount?: number) {
    return this.registryOperations.cleanupSessions(keepRecentCount);
  }

  public refreshHealth() {
    return this.registryOperations.refreshHealth();
  }

  public runMaintenance(now: Date = new Date()) {
    return this.registryOperations.runMaintenance(now);
  }

  public resetOperationalState(now: Date = new Date()) {
    return this.registryOperations.resetOperationalState(now);
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
