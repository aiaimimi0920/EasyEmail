import { clamp, createId, type CredentialSetDefinition } from "../shared/index.js";
import { createDisabledMailAliasService, type MailAliasService } from "../alias/service.js";
import {
  createDefaultEasyEmailProviderAdapters,
  createEasyEmailRegistryFromCatalog,
} from "./catalog.js";
import {
  applyCredentialSetsToRegistry,
} from "./credentials.js";
import {
  openMailboxWithPlan,
  readAuthenticationLinkFromProvider,
  readVerificationCodeFromProvider,
  resolveMailboxOpenCandidateProviderTypeKeys,
  shouldFallbackMailboxOpen,
} from "./mailbox.js";
import {
  recordMailboxOpenFailure,
  reportMailboxOutcomeToRegistry,
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
import { extractAuthenticationLinksFromContent } from "../domain/auth-links.js";
import { extractOtpCode } from "../domain/otp.js";
import { MailRegistry } from "../domain/registry.js";
import {
  normalizeMailProviderTypeKey,
} from "../domain/models.js";
import { MailboxBindingService, MailboxDispatcher } from "../dispatch/index.js";
import type {
  ActionLinkCandidate,
  AuthenticationLinkResult,
  HostBinding,
  MailAliasOutcome,
  MailAliasPlan,
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
  MailboxRecoveryStrategy,
} from "../providers/contracts.js";
import { createMailProviderAdapterMap } from "../providers/index.js";
import { CloudflareTempEmailRuntimeController } from "../providers/cloudflare_temp_email/control/index.js";
import { CloudflareTempEmailProvisioner } from "../providers/cloudflare_temp_email/provisioning/index.js";
import {
  MoemailClient,
  resolveMoemailConfig,
  type MoemailMailboxListingEntry,
} from "../providers/moemail/client.js";
import {
  createDefaultDispatchStrategyRegistry,
  type DispatchStrategyRegistry,
} from "../strategies/index.js";
import {
  MAIL_BUSINESS_STRATEGIES,
  MAIL_PROVIDER_GROUPS,
  mergeMailRoutingProfiles,
  normalizeMailBusinessStrategyId,
  resolveMailRoutingProfileFromProfiles,
} from "../domain/strategy-mode.js";

function createDefaultRegistry(now: Date = new Date()): MailRegistry {
  return createEasyEmailRegistryFromCatalog({}, now);
}

function resolveActionLinks(input: {
  sender?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  actionLinks?: ActionLinkCandidate[];
}): ActionLinkCandidate[] | undefined {
  if (Array.isArray(input.actionLinks) && input.actionLinks.length > 0) {
    return [...input.actionLinks];
  }

  const extracted = extractAuthenticationLinksFromContent({
    sender: input.sender,
    subject: input.subject,
    textBody: input.textBody,
    htmlBody: input.htmlBody,
  });
  return extracted.length > 0 ? extracted : undefined;
}

function isActiveProbeDisabled(instance: ProviderInstance): boolean {
  return instance.metadata.allowActiveProbe?.trim().toLowerCase() === "false";
}

function parseOptionalTimestamp(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MOEMAIL_CAPACITY_RECOVERY_MARKERS = [
  "no available moemail credentials for generate",
  "moemail_capacity_exhausted",
  "\"code\":\"moemail_capacity_exhausted\"",
  "[code=moemail_capacity_exhausted]",
  "moemail_upstream_transient",
  "maximum mailbox",
  "max mailbox",
  "mailbox count limit",
  "最大邮箱数量限制",
] as const;
const M2U_CAPACITY_RECOVERY_MARKERS = [
  "m2u_capacity_failure",
  "m2u_transient_failure",
] as const;

function inferMailboxCapacityRecoveryProviderType(input: {
  providerTypeKey?: string;
  failureCode?: string;
  detail?: string;
}): MailProviderTypeKey | undefined {
  const normalizedProviderTypeKey = normalizeMailProviderTypeKey(input.providerTypeKey);
  if (normalizedProviderTypeKey) {
    return normalizedProviderTypeKey;
  }

  const combined = [
    input.failureCode?.trim(),
    input.detail?.trim(),
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ")
    .toLowerCase();

  if (!combined) {
    return undefined;
  }

  if (MOEMAIL_CAPACITY_RECOVERY_MARKERS.some((marker) => combined.includes(marker))) {
    return "moemail";
  }
  if (M2U_CAPACITY_RECOVERY_MARKERS.some((marker) => combined.includes(marker))) {
    return "m2u";
  }

  return undefined;
}

function normalizeMailboxOpenError(error: unknown): unknown {
  if (error instanceof EasyEmailError) {
    if (error.code === "MOEMAIL_CAPACITY_EXHAUSTED") {
      return new EasyEmailError("MAILBOX_CAPACITY_UNAVAILABLE", error.message);
    }
    if (error.code === "MOEMAIL_UPSTREAM_TRANSIENT") {
      return new EasyEmailError("MAILBOX_UPSTREAM_TRANSIENT", error.message);
    }
    return error;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  if (normalized.includes("m2u_capacity_failure")) {
    return new EasyEmailError("MAILBOX_CAPACITY_UNAVAILABLE", message);
  }
  if (normalized.includes("m2u_transient_failure")) {
    return new EasyEmailError("MAILBOX_UPSTREAM_TRANSIENT", message);
  }
  return error;
}

function shouldCleanupMoemailMailboxEntry(
  entry: MoemailMailboxListingEntry,
  {
    nowMs,
    staleAfterMs,
    upstreamExpiryTimeMs,
  }: {
    nowMs: number;
    staleAfterMs: number;
    upstreamExpiryTimeMs: number;
  },
): { ok: boolean; reason: string } {
  const createdAtMs = parseOptionalTimestamp(entry.createdAt);
  if (createdAtMs !== undefined) {
    if (createdAtMs <= nowMs - staleAfterMs) {
      return { ok: true, reason: "age_threshold_reached" };
    }
    return { ok: false, reason: "not_old_enough" };
  }

  const expiresAtMs = parseOptionalTimestamp(entry.expiresAt);
  if (expiresAtMs !== undefined) {
    const remainingMs = expiresAtMs - nowMs;
    // When createdAt is unavailable, infer mailbox age from the configured
    // upstream expiry window for this specific MoEmail instance.
    if (remainingMs <= Math.max(0, upstreamExpiryTimeMs - staleAfterMs)) {
      return { ok: true, reason: "remaining_lifetime_threshold_reached" };
    }
    return { ok: false, reason: "remaining_lifetime_too_high" };
  }

  return { ok: false, reason: "missing_timestamps" };
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
  }

  public getCatalog(): EasyEmailCatalog {
    this.syncOperationalState();
    return {
      providerTypes: this.registry.listProviderTypes(),
      runtimeTemplates: this.registry.listRuntimeTemplates(),
      strategyProfiles: this.registry.listStrategies(),
      providerGroups: MAIL_PROVIDER_GROUPS,
      businessStrategies: MAIL_BUSINESS_STRATEGIES,
      routingProfiles: this.routingProfiles.map((item) => ({
        ...item,
        providerSelections: item.providerSelections ? [...item.providerSelections] : undefined,
        healthGate: item.healthGate ? { ...item.healthGate } : undefined,
      })),
      defaultStrategyModeId: this.defaultStrategyMode?.modeId,
      defaultStrategyMode: this.defaultStrategyMode,
      supportsStrategyMode: true,
    };
  }

  public saveProviderType(providerType: ProviderTypeDefinition): void {
    this.registry.saveProviderType({
      ...providerType,
      key: normalizeMailProviderTypeKey(providerType.key) ?? providerType.key,
    });
  }

  public saveProviderInstance(instance: ProviderInstance): void {
    this.registry.saveInstance({
      ...instance,
      providerTypeKey: normalizeMailProviderTypeKey(instance.providerTypeKey) ?? instance.providerTypeKey,
    });
  }

  public saveStrategyProfile(profile: StrategyProfile): void {
    this.registry.saveStrategy(profile);
  }

  public saveRuntimeTemplate(template: RuntimeTemplate): void {
    this.registry.saveRuntimeTemplate(template);
  }

  public saveCredentialSet(credentialSet: ProviderCredentialSet): void {
    this.registry.saveCredentialSet(credentialSet);
  }

  public saveCredentialBinding(binding: ProviderCredentialBinding): void {
    this.registry.saveCredentialBinding(binding);
  }

  public saveBinding(binding: HostBinding): void {
    this.registry.saveBinding(binding);
  }

  public replaceCredentialBindingsForInstance(
    providerInstanceId: string,
    bindings: ProviderCredentialBinding[],
  ): void {
    this.registry.deleteCredentialBindingsForInstance(providerInstanceId);
    for (const binding of bindings) {
      this.registry.saveCredentialBinding(binding);
    }
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
    const instance = this.registry.findInstanceById(providerInstanceId);
    if (!instance) {
      throw new EasyEmailError("PROVIDER_INSTANCE_NOT_FOUND", `Unknown provider instance: ${providerInstanceId}.`);
    }

    return applyCredentialSetsToRegistry(this.registry, instance, credentialSets, now);
  }

  public async registerCloudflareTempEmailRuntime(
    request: RegisterCloudflareTempEmailRuntimeRequest,
    now: Date = new Date(),
  ): Promise<RegisterCloudflareTempEmailRuntimeResult> {
    const template = this.resolveCloudflareTempEmailTemplate(request.templateId);
    const requestedInstanceId = request.instanceId?.trim() || undefined;
    const existing = requestedInstanceId ? this.registry.findInstanceById(requestedInstanceId) : undefined;
    const instanceId = existing?.id ?? requestedInstanceId ?? createId("mailinst", now);
    const created = existing === undefined;
    const createdAt = existing?.createdAt || now.toISOString();

    const instance: ProviderInstance = {
      id: instanceId,
      providerTypeKey: "cloudflare_temp_email",
      displayName: request.displayName?.trim() || existing?.displayName || `${template.displayName} ${instanceId.slice(-4)}`,
      status: existing?.status ?? "active",
      runtimeKind: "cloudflare_temp_email-runtime",
      connectorKind: request.connectorKind?.trim() || existing?.connectorKind || "cloudflare_temp_email-connector",
      shared: request.shared ?? existing?.shared ?? template.sharedByDefault,
      costTier: existing?.costTier ?? "paid",
      healthScore: existing?.healthScore ?? 1,
      averageLatencyMs: existing?.averageLatencyMs ?? 250,
      connectionRef: request.connectionRef?.trim() || request.baseUrl.trim(),
      hostBindings: existing?.hostBindings ? [...existing.hostBindings] : [],
      groupKeys: request.groupKeys ? [...request.groupKeys] : (existing?.groupKeys ? [...existing.groupKeys] : []),
      metadata: {
        ...(existing?.metadata ?? {}),
        templateId: template.id,
        roleKey: template.roleKey,
        domain: request.domain?.trim() || existing?.metadata.domain || template.metadata.domain || "cloudflare-temp-email.local",
        deploymentTarget: request.deploymentTarget?.trim()
          || existing?.metadata.deploymentTarget
          || template.metadata.deploymentTarget
          || "worker-node",
        baseUrl: request.baseUrl.trim(),
        strictMode: String(this.strictProviderMode),
        ...(request.customAuth !== undefined
          ? { customAuth: request.customAuth.trim() }
          : (existing?.metadata.customAuth ? { customAuth: existing.metadata.customAuth } : {})),
        ...(request.domains && request.domains.length > 0
          ? {
              domains: request.domains
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
                .join(","),
              domainsJson: JSON.stringify(
                request.domains
                  .map((item) => item.trim().toLowerCase())
                  .filter(Boolean),
              ),
            }
          : {}),
        ...(request.randomSubdomainDomains && request.randomSubdomainDomains.length > 0
          ? {
              randomSubdomainDomains: request.randomSubdomainDomains
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
                .join(","),
              randomSubdomainDomainsJson: JSON.stringify(
                request.randomSubdomainDomains
                  .map((item) => item.trim().toLowerCase())
                  .filter(Boolean),
              ),
            }
          : {}),
      },
      createdAt,
      updatedAt: now.toISOString(),
    };

    this.registry.saveInstance(instance);
    const health = await this.probeProviderInstance(instance.id, now);
    const savedInstance = this.registry.findInstanceById(instance.id) ?? instance;
    const runtimePlan = this.runtimeController.createRuntimePlan(savedInstance, template);

    return {
      instance: savedInstance,
      health,
      runtimePlan,
      created,
    };
  }

  public async probeProviderInstance(
    instanceId: string,
    now: Date = new Date(),
  ): Promise<ProviderHealthProbeResult> {
    this.syncOperationalState(now);
    const instance = this.registry.findInstanceById(instanceId);
    if (!instance) {
      throw new EasyEmailError("PROVIDER_INSTANCE_NOT_FOUND", `Unknown provider instance: ${instanceId}.`);
    }

    const probe = await this.executeProviderProbe(instance);
    const nextHealthScore = probe.ok
      ? clamp(Math.max(instance.healthScore, 0.85), 0.1, 1)
      : clamp(Math.min(instance.healthScore, 0.25), 0.1, 1);
    const nextStatus = probe.ok ? "active" : "degraded";

    const nextInstance: ProviderInstance = {
      ...instance,
      status: nextStatus,
      healthScore: nextHealthScore,
      averageLatencyMs: probe.averageLatencyMs,
      updatedAt: now.toISOString(),
      metadata: {
        ...instance.metadata,
        ...(probe.metadata ?? {}),
      },
    };
    this.registry.saveInstance(nextInstance);
    this.syncOperationalState(now);
    const effectiveInstance = this.registry.findInstanceById(instanceId) ?? nextInstance;

    return {
      instanceId: effectiveInstance.id,
      providerTypeKey: effectiveInstance.providerTypeKey,
      ok: probe.ok,
      status: effectiveInstance.status,
      healthScore: effectiveInstance.healthScore,
      averageLatencyMs: effectiveInstance.averageLatencyMs,
      checkedAt: now.toISOString(),
      detail: probe.detail,
    };
  }

  public async probeAllProviderInstances(now: Date = new Date()): Promise<ProviderHealthProbeResult[]> {
    this.syncOperationalState(now);
    const instances = this.registry.listInstances().filter((instance) => !isActiveProbeDisabled(instance));
    const settled = await Promise.allSettled(
      instances.map((instance) => this.probeProviderInstance(instance.id, now)),
    );

    return settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") {
        return outcome.value;
      }
      const instance = instances[index]!;
      const error = outcome.reason;
      return {
        instanceId: instance.id,
        providerTypeKey: instance.providerTypeKey,
        ok: false,
        status: "degraded" as const,
        healthScore: clamp(Math.min(instance.healthScore, 0.25), 0.1, 1),
        averageLatencyMs: instance.averageLatencyMs,
        checkedAt: now.toISOString(),
        detail: error instanceof Error ? error.message : String(error),
      };
    });
  }

  public planMailbox(request: VerificationMailboxRequest, now: Date = new Date()): MailboxPlanResult {
    this.syncOperationalState(now);
    const normalizedRequest = this.normalizeMailboxRequest(request);
    return {
      ...this.dispatcher.resolveMailboxPlan(normalizedRequest, now, false),
      aliasPlan: this.planAliasSafely(normalizedRequest),
    };
  }

  public async openMailbox(
    request: VerificationMailboxRequest,
    now: Date = new Date(),
  ): Promise<VerificationMailboxOpenResult> {
    this.syncOperationalState(now);
    const normalizedRequest = this.normalizeMailboxRequest(request);
    const initialPlan = this.dispatcher.resolveMailboxPlan(normalizedRequest, now, true);
    const candidateProviderTypeKeys = resolveMailboxOpenCandidateProviderTypeKeys(initialPlan);
    let lastError: unknown;

    for (const providerTypeKey of candidateProviderTypeKeys) {
      const plan = providerTypeKey === initialPlan.providerType.key
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

      try {
        const opened = await openMailboxWithPlan({
          request: normalizedRequest,
          plan,
          now,
          registry: this.registry,
          bindings: this.bindings,
          adapterMap: this.adapterMap,
        });

        const aliasOutcome = await this.createAliasOutcomeSafely(normalizedRequest, now);
        const session = this.persistAliasOutcomeOnSession(opened.session, aliasOutcome);

        return {
          ...opened,
          session,
          aliasOutcome,
        };
      } catch (error) {
        const normalizedError = normalizeMailboxOpenError(error);
        recordMailboxOpenFailure(this.registry, plan.instance, normalizedError, now);
        this.syncOperationalState(now);
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
  ): Promise<{
    session: MailboxSession;
    providerInstanceId: string;
    providerTypeKey: MailboxSession["providerTypeKey"];
    released: boolean;
    detail?: string;
  }> {
    this.syncOperationalState(now);
    const session = this.registry.findSessionById(sessionId);
    if (!session) {
      throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${sessionId}.`);
    }

    const instance = this.registry.findInstanceById(session.providerInstanceId);
    if (!instance) {
      throw new EasyEmailError(
        "PROVIDER_INSTANCE_NOT_FOUND",
        `Unknown provider instance for mailbox session ${sessionId}: ${session.providerInstanceId}.`,
      );
    }

    const adapter = this.adapterMap.get(session.providerTypeKey);
    const credentialSets = this.registry.resolveCredentialSetsForInstance(instance.id, "poll");
    const releaseResult = adapter?.releaseMailboxSession
      ? await adapter.releaseMailboxSession({
        session,
        instance,
        credentialSets,
        now,
        reason,
      })
      : {
        released: false,
        detail: "provider_does_not_support_release",
      };

    const nextSession: MailboxSession = {
      ...session,
      status: session.status === "resolved" ? "resolved" : "expired",
      metadata: {
        ...session.metadata,
        releasedAt: now.toISOString(),
        ...(reason?.trim() ? { releaseReason: reason.trim() } : {}),
        releaseStatus: releaseResult?.released ? "released" : "skipped",
        ...(releaseResult?.detail ? { releaseDetail: releaseResult.detail } : {}),
      },
    };
    this.registry.saveSession(nextSession);

    return {
      session: nextSession,
      providerInstanceId: instance.id,
      providerTypeKey: session.providerTypeKey,
      released: Boolean(releaseResult?.released),
      detail: releaseResult?.detail,
    };
  }

  public async recoverMailboxCapacity(
    input: {
      failureCode?: string;
      detail?: string;
      providerTypeKey?: string;
      providerInstanceId?: string;
      staleAfterSeconds?: number;
      maxDeleteCount?: number;
      force?: boolean;
    },
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
  ): Promise<{
    providerInstanceId: string;
    staleAfterSeconds: number;
    force: boolean;
    scannedCount: number;
    deletedCount: number;
    skippedCount: number;
    nextCursor?: string;
    deleted: Array<{ emailId: string; email: string; detail?: string }>;
    skipped: Array<{ emailId: string; email: string; reason: string }>;
  }> {
    this.syncOperationalState(now);

    const moemailInstances = this.getSnapshot().instances.filter((item) => item.providerTypeKey === "moemail");
    if (moemailInstances.length <= 0) {
      throw new EasyEmailError("PROVIDER_INSTANCE_NOT_FOUND", "No MoEmail provider instance is registered.");
    }

    const normalizedProviderInstanceId = providerInstanceId?.trim();
    if (!normalizedProviderInstanceId && moemailInstances.length > 1) {
      throw new EasyEmailError(
        "PROVIDER_INSTANCE_ID_REQUIRED",
        "Multiple MoEmail provider instances are registered. Specify providerInstanceId.",
      );
    }

    const instance = normalizedProviderInstanceId
      ? moemailInstances.find((item) => item.id === normalizedProviderInstanceId)
      : moemailInstances[0];
    if (!instance) {
      throw new EasyEmailError(
        "PROVIDER_INSTANCE_NOT_FOUND",
        `Unknown provider instance: ${normalizedProviderInstanceId}.`,
      );
    }

    const credentialSets = this.registry.resolveCredentialSetsForInstance(instance.id, "poll");
    const moemailConfig = resolveMoemailConfig(instance, credentialSets, {
      namespace: `mail:moemail:maintenance:${instance.id}`,
    });
    if (moemailConfig.credentialSets.length <= 0) {
      throw new EasyEmailError("MOEMAIL_CONFIGURATION_MISSING", `MoEmail instance ${instance.id} is unavailable.`);
    }
    const client = new MoemailClient(moemailConfig);

    const forceCleanup = Boolean(force);
    const normalizedStaleAfterSeconds = forceCleanup ? 0 : Math.max(60, Math.trunc(staleAfterSeconds || 300));
    const staleAfterMs = normalizedStaleAfterSeconds * 1000;
    const normalizedMaxDeleteCount = Math.max(1, Math.trunc(maxDeleteCount || 200));
    const nowMs = now.getTime();

    let cursor: string | undefined;
    let scannedCount = 0;
    let deletedCount = 0;
    let skippedCount = 0;
    const deleted: Array<{ emailId: string; email: string; detail?: string }> = [];
    const skipped: Array<{ emailId: string; email: string; reason: string }> = [];

    for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
      const page = await client.listEmails(cursor, "poll");
      for (const entry of page.emails) {
        scannedCount += 1;

        const decision = forceCleanup
          ? { ok: true, reason: "force_cleanup" }
          : shouldCleanupMoemailMailboxEntry(entry, {
            nowMs,
            staleAfterMs,
            upstreamExpiryTimeMs: moemailConfig.expiryTimeMs,
          });
        if (!decision.ok) {
          skippedCount += 1;
          if (skipped.length < 50) {
            skipped.push({
              emailId: entry.emailId,
              email: entry.email,
              reason: decision.reason,
            });
          }
          continue;
        }

        if (deletedCount >= normalizedMaxDeleteCount) {
          skippedCount += 1;
          if (skipped.length < 50) {
            skipped.push({
              emailId: entry.emailId,
              email: entry.email,
              reason: "delete_limit_reached",
            });
          }
          continue;
        }

        try {
          const result = await client.deleteMailbox(entry.emailId, "poll");
          if (result.released) {
            deletedCount += 1;
            if (deleted.length < 50) {
              deleted.push({
                emailId: entry.emailId,
                email: entry.email,
                detail: result.detail,
              });
            }
            continue;
          }
          skippedCount += 1;
          if (skipped.length < 50) {
            skipped.push({
              emailId: entry.emailId,
              email: entry.email,
              reason: result.detail || "delete_skipped",
            });
          }
        } catch (error) {
          skippedCount += 1;
          if (skipped.length < 50) {
            skipped.push({
              emailId: entry.emailId,
              email: entry.email,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      cursor = page.nextCursor?.trim() || undefined;
      if (!cursor) {
        break;
      }
    }

    return {
      providerInstanceId: instance.id,
      staleAfterSeconds: normalizedStaleAfterSeconds,
      force: forceCleanup,
      scannedCount,
      deletedCount,
      skippedCount,
      nextCursor: cursor,
      deleted,
      skipped,
    };
  }

  public observeMessage(input: ObserveMessageInput, now: Date = new Date()): ObservedMessage {
    const session = this.registry.findSessionById(input.sessionId);

    if (!session) {
      throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${input.sessionId}.`);
    }

    const extracted = extractOtpCode(input);
    const actionLinks = resolveActionLinks(input);
    const message: ObservedMessage = {
      id: createId("message", now),
      sessionId: session.id,
      providerInstanceId: session.providerInstanceId,
      observedAt: input.observedAt ?? now.toISOString(),
      sender: input.sender,
      subject: input.subject,
      htmlBody: input.htmlBody,
      textBody: input.textBody,
      extractedCode: extracted?.code,
      extractedCandidates: extracted?.candidates,
      codeSource: extracted?.source,
      ...(actionLinks ? { actionLinks } : {}),
    };

    this.registry.saveMessage(message);

    if (message.extractedCode) {
      this.registry.saveSession({
        ...session,
        status: "resolved",
      });
    }

    return message;
  }

  public async readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined> {
    const result = await readVerificationCodeFromProvider({
      sessionId,
      registry: this.registry,
      adapterMap: this.adapterMap,
    });
    this.syncOperationalState();
    return result;
  }

  public async readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined> {
    const result = await readAuthenticationLinkFromProvider({
      sessionId,
      registry: this.registry,
      adapterMap: this.adapterMap,
    });
    this.syncOperationalState();
    return result;
  }

  public async syncObservedMessages(sessionId: string): Promise<ObservedMessage[]> {
    const beforeIds = new Set(this.registry.listMessagesBySession(sessionId).map((message) => message.id));
    const synced = await readVerificationCodeFromProvider({
      sessionId,
      registry: this.registry,
      adapterMap: this.adapterMap,
    });
    const allMessages = this.registry.listMessagesBySession(sessionId);
    const newMessages = allMessages.filter((message) => !beforeIds.has(message.id));
    this.syncOperationalState();
    if (newMessages.length > 0) {
      return newMessages;
    }
    if (synced?.observedMessageId) {
      const matched = allMessages.find((message) => message.id === synced.observedMessageId);
      if (matched) {
        return [matched];
      }
    }
    return [];
  }

  public reportMailboxOutcome(
    report: MailboxOutcomeReport,
    now: Date = new Date(),
  ): MailboxOutcomeReportResult {
    const result = reportMailboxOutcomeToRegistry(this.registry, report, now);
    this.syncOperationalState(now);
    return result;
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

  private normalizeMailboxRequest(request: VerificationMailboxRequest): VerificationMailboxRequest {
    const routingProfile = !request.providerTypeKey
      ? resolveMailRoutingProfileFromProfiles(request.providerRoutingProfileId, this.routingProfiles)
      : undefined;
    const requestedDomain = request.requestedDomain?.trim().toLowerCase()
      || request.metadata?.requestedDomain?.trim().toLowerCase()
      || request.metadata?.mailcreateDomain?.trim().toLowerCase()
      || undefined;
    const requestedLocalPart = request.requestedLocalPart?.trim()
      || request.metadata?.requestedLocalPart?.trim()
      || request.metadata?.customLocalPart?.trim()
      || request.metadata?.mailcreateLocalPart?.trim()
      || request.metadata?.localPart?.trim()
      || request.metadata?.prefix?.trim()
      || undefined;
    const turnstileToken = request.turnstileToken?.trim()
      || request.metadata?.turnstileToken?.trim()
      || request.metadata?.cfTurnstileResponse?.trim()
      || request.metadata?.["cf-turnstile-response"]?.trim()
      || request.metadata?.turnstileResponse?.trim()
      || undefined;
    const metadata: Record<string, string> = {
      ...(request.metadata ?? {}),
    };

    if (requestedDomain) {
      metadata.requestedDomain = requestedDomain;
    } else {
      delete metadata.requestedDomain;
    }

    if (request.requestRandomSubdomain === true) {
      metadata.requestRandomSubdomain = "true";
    } else {
      delete metadata.requestRandomSubdomain;
    }

    if (requestedLocalPart) {
      metadata.requestedLocalPart = requestedLocalPart;
    } else {
      delete metadata.requestedLocalPart;
    }

    delete metadata.turnstileToken;
    delete metadata.turnstileResponse;
    delete metadata.cfTurnstileResponse;
    delete metadata["cf-turnstile-response"];
    delete metadata.customLocalPart;
    delete metadata.mailcreateLocalPart;
    delete metadata.localPart;
    delete metadata.prefix;

    return {
      ...request,
      providerRoutingProfileId: routingProfile?.id ?? request.providerRoutingProfileId?.trim() ?? undefined,
      requestedDomain,
      requestedLocalPart,
      turnstileToken,
      requestRandomSubdomain: request.requestRandomSubdomain === true,
      providerTypeKey: normalizeMailProviderTypeKey(request.providerTypeKey),
      providerStrategyModeId: normalizeMailBusinessStrategyId(
        request.providerStrategyModeId ?? routingProfile?.providerStrategyModeId,
      ),
      excludedProviderTypeKeys: request.excludedProviderTypeKeys
        ?.map((item) => normalizeMailProviderTypeKey(item))
        .filter((item): item is MailProviderTypeKey => item !== undefined),
      providerGroupSelections: (request.providerGroupSelections ?? routingProfile?.providerSelections)
        ?.map((item) => normalizeMailProviderTypeKey(item))
        .filter((item): item is MailProviderTypeKey => item !== undefined),
      strategyProfileId: request.strategyProfileId ?? routingProfile?.strategyProfileId,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
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
    input: {
      emailAddress: string;
      providerTypeKey?: MailProviderTypeKey;
      hostId?: string;
    },
    now: Date = new Date(),
  ): Promise<{
    recovered: boolean;
    strategy: MailboxRecoveryStrategy;
    providerTypeKey?: MailProviderTypeKey;
    providerInstanceId?: string;
    session?: MailboxSession;
    detail?: string;
  }> {
    this.syncOperationalState(now);
    const normalizedEmail = input.emailAddress.trim().toLowerCase();
    const normalizedProviderTypeKey = normalizeMailProviderTypeKey(input.providerTypeKey);
    const session = this.findMailboxSessionByEmailAddress(normalizedEmail, normalizedProviderTypeKey);

    if (session) {
      const instance = this.registry.findInstanceById(session.providerInstanceId);
      const adapter = instance ? this.adapterMap.get(instance.providerTypeKey) : undefined;
      if (instance && adapter?.recoverMailboxSession) {
        const credentialSets = instance
          ? this.registry.resolveCredentialSetsForInstance(instance.id, "generate")
          : [];
        const recovered = await adapter.recoverMailboxSession({
          emailAddress: normalizedEmail,
          hostId: input.hostId?.trim() || session.hostId,
          instance,
          credentialSets,
          now,
          session,
        });
        if (recovered) {
          this.registry.saveSession(recovered.session);
          return {
            recovered: true,
            strategy: recovered.strategy,
            providerTypeKey: recovered.session.providerTypeKey,
            providerInstanceId: recovered.session.providerInstanceId,
            session: recovered.session,
            detail: recovered.detail,
          };
        }
      }

      return {
        recovered: true,
        strategy: "session_restore",
        providerTypeKey: session.providerTypeKey,
        providerInstanceId: session.providerInstanceId,
        session,
        detail: "recovered_from_persisted_state",
      };
    }

    if (!normalizedProviderTypeKey) {
      return {
        recovered: false,
        strategy: "not_supported",
        detail: "provider_type_required_for_provider_recovery",
      };
    }

    const candidates = this.registry.listActiveInstancesByType(normalizedProviderTypeKey);
    const adapter = this.adapterMap.get(normalizedProviderTypeKey);
    if (!adapter?.recoverMailboxSession || candidates.length === 0) {
      return {
        recovered: false,
        strategy: "not_supported",
        providerTypeKey: normalizedProviderTypeKey,
        detail: "provider_recovery_not_supported",
      };
    }

    for (const instance of candidates) {
      const credentialSets = this.registry.resolveCredentialSetsForInstance(instance.id, "generate");
      const recovered = await adapter.recoverMailboxSession({
        emailAddress: normalizedEmail,
        hostId: input.hostId?.trim() || `recovery:${normalizedProviderTypeKey}`,
        instance,
        credentialSets,
        now,
      });

      if (!recovered) {
        continue;
      }

      this.registry.saveSession(recovered.session);
      return {
        recovered: true,
        strategy: recovered.strategy,
        providerTypeKey: recovered.session.providerTypeKey,
        providerInstanceId: recovered.session.providerInstanceId,
        session: recovered.session,
        detail: recovered.detail,
      };
    }

    return {
      recovered: false,
      strategy: "not_supported",
      providerTypeKey: normalizedProviderTypeKey,
      detail: "provider_recovery_not_supported",
    };
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

  private persistAliasOutcomeOnSession(
    session: import("../domain/models.js").MailboxSession,
    aliasOutcome: MailAliasOutcome,
  ) {
    const metadata: Record<string, string> = {
      ...session.metadata,
      aliasRequested: String(aliasOutcome.requested),
      aliasStatus: aliasOutcome.status,
    };

    if (aliasOutcome.providerKey) {
      metadata.aliasProviderKey = aliasOutcome.providerKey;
    } else {
      delete metadata.aliasProviderKey;
    }

    if (aliasOutcome.alias?.emailAddress) {
      metadata.aliasEmailAddress = aliasOutcome.alias.emailAddress;
    } else {
      delete metadata.aliasEmailAddress;
    }

    if (aliasOutcome.alias?.createdAt) {
      metadata.aliasCreatedAt = aliasOutcome.alias.createdAt;
    } else {
      delete metadata.aliasCreatedAt;
    }

    if (aliasOutcome.failureReason) {
      metadata.aliasFailureReason = aliasOutcome.failureReason;
    } else {
      delete metadata.aliasFailureReason;
    }

    if (aliasOutcome.failureMessage) {
      metadata.aliasFailureMessage = aliasOutcome.failureMessage;
    } else {
      delete metadata.aliasFailureMessage;
    }

    const nextSession = {
      ...session,
      metadata,
    };
    this.registry.saveSession(nextSession);
    return nextSession;
  }

  private async createAliasOutcomeSafely(
    request: VerificationMailboxRequest,
    now: Date,
  ): Promise<MailAliasOutcome> {
    try {
      return await this.aliasService.createAliasOutcome(request, now);
    } catch (error) {
      const aliasPlan = this.planAliasSafely(request);
      if (aliasPlan.status === "not_requested") {
        return {
          requested: false,
          status: "not_requested",
        };
      }

      if (aliasPlan.status === "skipped_disabled") {
        return {
          requested: true,
          status: "skipped_disabled",
          providerKey: aliasPlan.providerKey,
        };
      }

      if (
        aliasPlan.status === "failed"
        && aliasPlan.failureReason
        && aliasPlan.failureMessage
        && aliasPlan.failureReason !== "alias_plan_unexpected_error"
      ) {
        return {
          requested: true,
          status: "failed",
          providerKey: aliasPlan.providerKey ?? "ddg",
          failureReason: aliasPlan.failureReason,
          failureMessage: aliasPlan.failureMessage,
        };
      }

      return {
        requested: true,
        status: "failed",
        providerKey: aliasPlan.providerKey ?? "ddg",
        failureReason: "alias_unexpected_error",
        failureMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private planAliasSafely(request: VerificationMailboxRequest): MailAliasPlan {
    try {
      return this.aliasService.planAlias(request);
    } catch (error) {
      if (request.includeAliasEmail !== true) {
        return {
          requested: false,
          status: "not_requested",
        };
      }

      return {
        requested: true,
        status: "failed",
        providerKey: "ddg",
        failureReason: "alias_plan_unexpected_error",
        failureMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveCloudflareTempEmailTemplate(templateId?: string): RuntimeTemplate {
    if (templateId) {
      const matched = this.registry.findRuntimeTemplateById(templateId);
      if (matched?.providerTypeKey === "cloudflare_temp_email") {
        return matched;
      }
    }

    const fallback = this.registry.listRuntimeTemplates().find((template) => template.providerTypeKey === "cloudflare_temp_email");
    if (!fallback) {
      throw new EasyEmailError("CLOUDFLARE_TEMP_EMAIL_TEMPLATE_MISSING", "No Cloudflare Temp Email runtime template is registered.");
    }

    return fallback;
  }

  private async executeProviderProbe(instance: ProviderInstance): Promise<{
    ok: boolean;
    detail: string;
    averageLatencyMs: number;
    metadata?: Record<string, string>;
  }> {
    const adapter = this.adapterMap.get(instance.providerTypeKey);
    if (adapter) {
      const credentialSets = this.registry.resolveCredentialSetsForInstance(instance.id, "poll");
      return await adapter.probeInstance({
        instance,
        credentialSets,
        now: new Date(),
      });
    }

    return {
      ok: false,
      detail: `No probe is available for ${instance.providerTypeKey}.`,
      averageLatencyMs: instance.averageLatencyMs,
    };
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
