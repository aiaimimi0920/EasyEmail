import { parseTimestampMs } from "../shared/utils.js";
import { EasyEmailError } from "../domain/errors.js";
import {
  normalizeMailProviderTypeKey,
} from "../domain/models.js";
import type {
  MailProviderTypeKey,
  MailStrategyModeResolution,
  MailboxPlanResult,
  ProviderInstance,
  ProviderTypeDefinition,
  StrategyProfile,
  VerificationMailboxRequest,
} from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";
import type { DispatchStrategyRegistry } from "../strategies/index.js";
import { MailboxBindingService } from "./binding-service.js";
import { CloudflareTempEmailRuntimeController } from "../providers/cloudflare_temp_email/control/index.js";
import { CloudflareTempEmailProvisioner } from "../providers/cloudflare_temp_email/provisioning/index.js";
import { getMailProviderTypeForGroup, resolveMailStrategyMode } from "../domain/strategy-mode.js";
import { synchronizeProviderOperationalState } from "../service/provider-operational-state.js";
import { parseProviderPerformanceStats } from "../service/outcomes.js";

interface ExternalSelection {
  instance: ProviderInstance;
  strategyProfile: StrategyProfile;
}

interface RoutingProfileLookup {
  id: string;
  providerStrategyModeId?: MailStrategyModeResolution["modeId"];
  providerSelections?: MailStrategyModeResolution["providerSelections"];
  strategyProfileId?: string;
  healthGate?: {
    minimumHealthScore?: number;
    maxConsecutiveFailures?: number;
    recentFailureWindowMs?: number;
    recentFailurePenalty?: number;
  };
}

function parseNonNegativeInteger(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isMailboxDeliveryFailureReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("otp_timeout")
    || normalized.includes("timeout waiting for 6-digit code")
    || normalized.includes("code never arrived")
    || normalized.includes("mailbox")
  );
}

function isProviderCapacityFailureReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("status 429")
    || normalized.includes(" 429")
    || normalized.includes("too many requests")
    || normalized.includes("rate limit")
    || normalized.includes("quota exceeded")
    || normalized.includes("最大邮箱数量限制")
    || normalized.includes("已达到最大邮箱数量限制")
    || normalized.includes("maximum mailbox")
    || normalized.includes("max mailbox")
    || normalized.includes("mailbox count limit")
  );
}

function computeRecentMailboxFailurePenalty(instance: ProviderInstance, nowMs: number): number {
  const reason = instance.metadata.lastRegistrationFailureReason;
  const isMailboxFailure = isMailboxDeliveryFailureReason(reason);
  const isCapacityFailure = isProviderCapacityFailureReason(reason);
  const cooldownUntilMs = parseTimestampMs(instance.metadata.cooldownUntil);
  if (cooldownUntilMs != null && cooldownUntilMs > nowMs) {
    const remainingMs = cooldownUntilMs - nowMs;
    const cooldownPenalty = remainingMs > 30 * 60 * 1000
      ? 0.28
      : remainingMs > 10 * 60 * 1000
        ? 0.2
        : 0.12;
    return cooldownPenalty + Math.min(parseNonNegativeInteger(instance.metadata.consecutiveFailureCount), 5) * 0.03;
  }

  if (!isMailboxFailure && !isCapacityFailure) {
    return Math.min(parseNonNegativeInteger(instance.metadata.consecutiveFailureCount), 4) * 0.02;
  }

  const observedAtMs = parseTimestampMs(instance.metadata.lastRegistrationOutcomeAt);
  if (observedAtMs == null) {
    if (isCapacityFailure) {
      return instance.providerTypeKey === "duckmail" ? 0.42 : 0.32;
    }
    return instance.providerTypeKey === "duckmail" ? 0.3 : 0.18;
  }

  const ageMs = Math.max(0, nowMs - observedAtMs);
  if (ageMs > 6 * 60 * 60 * 1000) {
    return 0;
  }

  let penalty = isCapacityFailure
    ? (
        ageMs <= 30 * 60 * 1000
          ? 0.32
          : ageMs <= 2 * 60 * 60 * 1000
            ? 0.22
            : 0.12
      )
    : (
        ageMs <= 30 * 60 * 1000
          ? 0.24
          : ageMs <= 2 * 60 * 60 * 1000
            ? 0.16
            : 0.08
      );

  // DuckMail currently tends to accept mailbox creation but miss OTP relay.
  if (instance.providerTypeKey === "duckmail") {
    penalty += isCapacityFailure ? 0.1 : 0.14;
  }

  return penalty;
}

export interface MailboxDispatcherDependencies {
  registry: MailRegistry;
  bindings: MailboxBindingService;
  provisioner: CloudflareTempEmailProvisioner;
  runtimeController: CloudflareTempEmailRuntimeController;
  strategyRegistry: DispatchStrategyRegistry;
  defaultStrategyMode?: MailStrategyModeResolution;
  routingProfiles?: RoutingProfileLookup[];
}

export class MailboxDispatcher {
  private readonly registry: MailRegistry;

  private readonly bindings: MailboxBindingService;

  private readonly provisioner: CloudflareTempEmailProvisioner;

  private readonly runtimeController: CloudflareTempEmailRuntimeController;

  private readonly strategyRegistry: DispatchStrategyRegistry;
  private readonly defaultStrategyMode?: MailStrategyModeResolution;
  private readonly routingProfiles = new Map<string, RoutingProfileLookup>();
  private readonly strategyModeRoundRobinCounters = new Map<string, number>();

  public constructor(deps: MailboxDispatcherDependencies) {
    this.registry = deps.registry;
    this.bindings = deps.bindings;
    this.provisioner = deps.provisioner;
    this.runtimeController = deps.runtimeController;
    this.strategyRegistry = deps.strategyRegistry;
    this.defaultStrategyMode = deps.defaultStrategyMode;
    for (const profile of deps.routingProfiles ?? []) {
      const normalizedId = profile.id.trim().toLowerCase();
      if (!normalizedId) {
        continue;
      }
      this.routingProfiles.set(normalizedId, {
        ...profile,
        id: normalizedId,
        providerSelections: profile.providerSelections ? [...profile.providerSelections] : undefined,
        healthGate: profile.healthGate ? { ...profile.healthGate } : undefined,
      });
    }
  }

  public resolveMailboxPlan(
    request: VerificationMailboxRequest,
    now: Date,
    persistProvisioning: boolean,
  ): MailboxPlanResult {
    synchronizeProviderOperationalState(this.registry, now);
    const normalizedRequest: VerificationMailboxRequest = {
      ...request,
      providerTypeKey: normalizeMailProviderTypeKey(request.providerTypeKey),
    };
    const excludedProviderTypeKeys = new Set(
      (normalizedRequest.excludedProviderTypeKeys ?? [])
        .map((item) => normalizeMailProviderTypeKey(item))
        .filter((item): item is MailProviderTypeKey => item !== undefined),
    );
    if (normalizedRequest.providerTypeKey && excludedProviderTypeKeys.has(normalizedRequest.providerTypeKey)) {
      throw new EasyEmailError(
        "PROVIDER_EXCLUDED",
        `Provider ${normalizedRequest.providerTypeKey} was explicitly excluded by the request.`,
      );
    }
    const requestedDomain = this.resolveRequestedDomain(normalizedRequest);
    const requestRandomSubdomain = normalizedRequest.requestRandomSubdomain === true;

    if (!normalizedRequest.providerTypeKey) {
      if (requestRandomSubdomain || requestedDomain) {
        return this.resolveMailboxPlanForProvider({
          ...normalizedRequest,
          providerTypeKey: "cloudflare_temp_email",
        }, now, persistProvisioning);
      }
      return this.resolveMailboxPlanByStrategy(normalizedRequest, now, persistProvisioning);
    }

    return this.resolveMailboxPlanForProvider(normalizedRequest as VerificationMailboxRequest & { providerTypeKey: MailProviderTypeKey }, now, persistProvisioning);
  }

  private resolveMailboxPlanForProvider(
    request: VerificationMailboxRequest & { providerTypeKey: MailProviderTypeKey },
    now: Date,
    persistProvisioning: boolean,
    strategyMode?: MailStrategyModeResolution,
  ): MailboxPlanResult {
    if (request.requestRandomSubdomain && request.providerTypeKey !== "cloudflare_temp_email") {
      throw new EasyEmailError(
        "RANDOM_SUBDOMAIN_UNSUPPORTED",
        `Provider ${request.providerTypeKey} does not support random subdomain mailbox creation.`,
      );
    }

    const providerType = this.registry.getProviderType(request.providerTypeKey);

    if (!providerType) {
      throw new EasyEmailError("PROVIDER_TYPE_NOT_FOUND", `Unknown mail provider type: ${request.providerTypeKey}.`);
    }

    const existingBinding =
      request.provisionMode === "always-create-dedicated"
        ? undefined
        : this.bindings.resolve(request.hostId, request.providerTypeKey, request.bindingMode);

    let instance = existingBinding;
    let strategyProfile: StrategyProfile | undefined;
    let requiresProvisioning = false;
    let runtimePlan = existingBinding?.providerTypeKey === "cloudflare_temp_email"
      ? this.createRuntimePlanIfAvailable(existingBinding)
      : undefined;

    if (!instance) {
      if (providerType.key === "cloudflare_temp_email") {
        const provisionResult = persistProvisioning
          ? this.provisioner.resolveOrProvision(request, now)
          : this.provisioner.preview(request, now);

        instance = provisionResult.instance;
        requiresProvisioning = provisionResult.created;
        runtimePlan = this.runtimeController.createRuntimePlan(provisionResult.instance, provisionResult.template);
      } else {
        const externalSelection = this.selectExternalInstance(providerType, request);
        instance = externalSelection.instance;
        strategyProfile = externalSelection.strategyProfile;
      }
    } else if (providerType.key !== "cloudflare_temp_email") {
      strategyProfile = this.resolveStrategyProfile(providerType, request);
    }

    if (!instance) {
      throw new EasyEmailError("PROVIDER_SELECTION_FAILED", `Unable to resolve a provider instance for ${providerType.key}.`);
    }

    const bindingResolution = this.bindings.preview({
      hostId: request.hostId,
      providerTypeKey: request.providerTypeKey,
      instance,
      bindingMode: request.bindingMode,
      groupKey: request.groupKey,
      now,
    });

    return {
      request,
      providerType,
      instance,
      binding: bindingResolution.binding,
      strategyProfile,
      reusedExistingBinding: bindingResolution.reusedExistingBinding,
      requiresProvisioning,
      runtimePlan,
      strategyMode,
    };
  }

  private resolveMailboxPlanByStrategy(
    request: VerificationMailboxRequest,
    now: Date,
    persistProvisioning: boolean,
  ): MailboxPlanResult {
    const routingProfile = this.resolveRoutingProfile(request.providerRoutingProfileId);
    const strategyMode = resolveMailStrategyMode({
      modeId: request.providerStrategyModeId
        ?? routingProfile?.providerStrategyModeId
        ?? this.defaultStrategyMode?.modeId,
      providerSelections: request.providerGroupSelections
        ?? routingProfile?.providerSelections
        ?? this.defaultStrategyMode?.providerSelections,
      requestedProfileId: request.strategyProfileId
        ?? routingProfile?.strategyProfileId
        ?? this.defaultStrategyMode?.strategyProfileId,
      strategies: this.registry.listStrategies(),
    });
    const preferredProviderType = request.preferredInstanceId
      ? this.registry.findInstanceById(request.preferredInstanceId)?.providerTypeKey
      : undefined;
    const providerTypeOrder = this.buildProviderTypeOrder(strategyMode, request, preferredProviderType, routingProfile);
    let lastError: EasyEmailError | undefined;

    for (const providerTypeKey of providerTypeOrder) {
      try {
        return this.resolveMailboxPlanForProvider({
          ...request,
          providerTypeKey,
          strategyProfileId: request.strategyProfileId ?? strategyMode.strategyProfileId,
        }, now, persistProvisioning, strategyMode);
      } catch (error) {
        if (this.isRecoverableStrategyError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new EasyEmailError(
      "PROVIDER_SELECTION_FAILED",
      `No mail provider route could be resolved for strategy mode "${strategyMode.modeId}".`,
    );
  }

  private selectExternalInstance(
    providerType: ProviderTypeDefinition,
    request: VerificationMailboxRequest,
  ): ExternalSelection {
    const candidates = this.registry.listActiveInstancesByType(providerType.key).filter((instance) => {
      if (request.groupKey && instance.groupKeys.length > 0) {
        return instance.groupKeys.includes(request.groupKey);
      }

      return true;
    });

    if (request.preferredInstanceId) {
      const preferred = candidates.find((instance) => instance.id === request.preferredInstanceId);

      if (preferred) {
        return {
          instance: preferred,
          strategyProfile: this.resolveStrategyProfile(providerType, request),
        };
      }
    }

    if (candidates.length === 0) {
      throw new EasyEmailError(
        "PROVIDER_INSTANCE_UNAVAILABLE",
        `No active provider instance is registered for ${providerType.displayName}.`,
      );
    }

    const strategyProfile = this.resolveStrategyProfile(providerType, request);
    const strategy = this.strategyRegistry.resolve(strategyProfile.key);

    if (!strategy) {
      throw new EasyEmailError("STRATEGY_NOT_FOUND", `Strategy ${strategyProfile.key} is not registered.`);
    }

    const selected = strategy.choose({
      request,
      profile: strategyProfile,
      instances: candidates,
    });

    if (!selected) {
      throw new EasyEmailError(
        "PROVIDER_SELECTION_FAILED",
        `Unable to select a provider instance for ${providerType.displayName}.`,
      );
    }

    return {
      instance: selected,
      strategyProfile,
    };
  }

  private resolveStrategyProfile(
    providerType: ProviderTypeDefinition,
    request: VerificationMailboxRequest,
  ): StrategyProfile {
    if (request.strategyProfileId) {
      const matched = this.registry.findStrategyById(request.strategyProfileId);

      if (matched) {
        return matched;
      }
    }

    const fallback = this.registry.listStrategies().find((profile) => profile.key === providerType.defaultStrategyKey);

    if (!fallback) {
      throw new EasyEmailError(
        "DEFAULT_STRATEGY_MISSING",
        `Default strategy ${providerType.defaultStrategyKey} is not registered.`,
      );
    }

    return fallback;
  }

  private createRuntimePlanIfAvailable(instance: ProviderInstance) {
    const templateId = instance.metadata.templateId;

    if (!templateId) {
      return undefined;
    }

    const template = this.registry.findRuntimeTemplateById(templateId);

    if (!template) {
      return undefined;
    }

    return this.runtimeController.createRuntimePlan(instance, template);
  }

  private buildProviderTypeOrder(
    strategyMode: MailStrategyModeResolution,
    request: VerificationMailboxRequest,
    preferredProviderType?: MailProviderTypeKey,
    routingProfile?: RoutingProfileLookup,
  ): MailProviderTypeKey[] {
    const groups = strategyMode.modeId === "random"
      ? this.shuffleValues(strategyMode.providerGroupOrder, `mail:${strategyMode.providerSelections.join("|")}`)
      : strategyMode.modeId === "available-first"
        ? this.orderProviderGroupsByAvailability(strategyMode.providerSelections, request, routingProfile)
        : strategyMode.providerGroupOrder;
    const excludedProviderTypeKeys = new Set(
      (request.excludedProviderTypeKeys ?? [])
        .map((item) => normalizeMailProviderTypeKey(item))
        .filter((item): item is MailProviderTypeKey => item !== undefined),
    );
    const providerTypes = groups
      .map((group) => getMailProviderTypeForGroup(group))
      .filter((providerTypeKey) => !excludedProviderTypeKeys.has(providerTypeKey));

    if (!preferredProviderType || !providerTypes.includes(preferredProviderType)) {
      return providerTypes;
    }

    return [preferredProviderType, ...providerTypes.filter((item) => item !== preferredProviderType)];
  }

  private rotateValues<T>(values: T[], key: string): T[] {
    if (values.length <= 1) {
      return [...values];
    }

    const current = this.strategyModeRoundRobinCounters.get(key) ?? 0;
    this.strategyModeRoundRobinCounters.set(key, current + 1);
    const index = current % values.length;
    return [...values.slice(index), ...values.slice(0, index)];
  }

  private shuffleValues<T>(values: T[], key: string): T[] {
    const rotated = this.rotateValues(values, key);
    if (rotated.length <= 2) {
      return rotated;
    }

    const [head, ...tail] = rotated;
    return [head, ...tail.sort(() => Math.random() - 0.5)];
  }

  private orderProviderGroupsByAvailability(
    providerGroups: MailStrategyModeResolution["providerSelections"],
    request: VerificationMailboxRequest,
    routingProfile?: RoutingProfileLookup,
  ): MailStrategyModeResolution["providerSelections"] {
    const groupOrderIndex = new Map(providerGroups.map((group, index) => [group, index]));
    const scores = new Map(providerGroups.map((group) => [
      group,
      this.computeProviderAvailabilityScore(
        getMailProviderTypeForGroup(group),
        request,
        routingProfile?.healthGate,
      ),
    ]));
    const effectiveScores = [...scores.values()].some((value) => Number.isFinite(value))
      ? scores
      : new Map(providerGroups.map((group) => [
          group,
          this.computeProviderAvailabilityScore(getMailProviderTypeForGroup(group), request),
        ]));
    const ordered = [...providerGroups].sort((left, right) => {
      const leftScore = effectiveScores.get(left) ?? Number.NEGATIVE_INFINITY;
      const rightScore = effectiveScores.get(right) ?? Number.NEGATIVE_INFINITY;
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return (groupOrderIndex.get(left) ?? 0) - (groupOrderIndex.get(right) ?? 0);
    });

    const rotated: MailStrategyModeResolution["providerSelections"] = [];
    for (let index = 0; index < ordered.length;) {
      const head = ordered[index]!;
      const headScore = effectiveScores.get(head) ?? Number.NEGATIVE_INFINITY;
      const cluster: MailStrategyModeResolution["providerSelections"] = [head];
      index += 1;
      while (index < ordered.length) {
        const next = ordered[index]!;
        const nextScore = effectiveScores.get(next) ?? Number.NEGATIVE_INFINITY;
        if (Math.abs(headScore - nextScore) > 0.04) {
          break;
        }
        cluster.push(next);
        index += 1;
      }

      rotated.push(
        ...(cluster.length > 1
          ? this.rotateValues(cluster, `availability:${providerGroups.join("|")}:${Math.round(headScore * 100)}`)
          : cluster),
      );
    }

    return rotated;
  }

  private computeProviderPerformanceScore(instance: ProviderInstance, nowMs: number): number {
    const stats = parseProviderPerformanceStats(instance.metadata.registrationStatsJson);
    const total = stats.successCount + stats.failureCount;
    const successRatio = total > 0 ? stats.successCount / total : 0.5;
    let score = (successRatio - 0.5) * 0.24;

    const lastSuccessAtMs = parseTimestampMs(stats.lastSuccessAt);
    if (lastSuccessAtMs != null) {
      const ageMs = Math.max(0, nowMs - lastSuccessAtMs);
      if (ageMs <= 15 * 60 * 1000) {
        score += 0.08;
      } else if (ageMs <= 60 * 60 * 1000) {
        score += 0.04;
      }
    }

    const lastFailureAtMs = parseTimestampMs(stats.lastFailureAt);
    if (lastFailureAtMs != null) {
      const ageMs = Math.max(0, nowMs - lastFailureAtMs);
      if (ageMs <= 15 * 60 * 1000) {
        score -= 0.14;
      } else if (ageMs <= 60 * 60 * 1000) {
        score -= 0.08;
      }
    }

    const consecutiveFailureCount = parseNonNegativeInteger(instance.metadata.consecutiveFailureCount);
    if (consecutiveFailureCount > 0) {
      score -= Math.min(consecutiveFailureCount, 5) * 0.035;
    }

    const cooldownUntilMs = parseTimestampMs(instance.metadata.cooldownUntil);
    if (cooldownUntilMs != null && cooldownUntilMs > nowMs) {
      score -= 0.12;
    }

    return score;
  }

  private computeProviderAvailabilityScore(
    providerTypeKey: MailProviderTypeKey,
    request: VerificationMailboxRequest,
    healthGate?: RoutingProfileLookup["healthGate"],
  ): number {
    const nowMs = Date.now();
    const candidates = this.registry.listActiveInstancesByType(providerTypeKey).filter((instance) => {
      if (request.groupKey && instance.groupKeys.length > 0) {
        return instance.groupKeys.includes(request.groupKey);
      }
      return true;
    });

    if (candidates.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }

    return candidates.reduce((best, instance) => {
      const consecutiveFailureCount = parseNonNegativeInteger(instance.metadata.consecutiveFailureCount);
      if (healthGate?.minimumHealthScore !== undefined && instance.healthScore < healthGate.minimumHealthScore) {
        return best;
      }
      if (healthGate?.maxConsecutiveFailures !== undefined && consecutiveFailureCount > healthGate.maxConsecutiveFailures) {
        return best;
      }

      const latencyPenalty = Math.min(Math.max(instance.averageLatencyMs, 0), 5_000) / 5_000 * 0.1;
      const statusBonus = instance.status === "active" ? 0.03 : instance.status === "degraded" ? -0.03 : 0;
      const recentFailurePenalty = computeRecentMailboxFailurePenalty(instance, nowMs);
      const performanceScore = this.computeProviderPerformanceScore(instance, nowMs);
      const gatePenalty = this.computeRecentFailureGatePenalty(instance, nowMs, healthGate);
      const score = instance.healthScore + statusBonus + performanceScore - latencyPenalty - recentFailurePenalty - gatePenalty;
      return Math.max(best, score);
    }, Number.NEGATIVE_INFINITY);
  }

  private computeRecentFailureGatePenalty(
    instance: ProviderInstance,
    nowMs: number,
    healthGate?: NonNullable<RoutingProfileLookup["healthGate"]>,
  ): number {
    if (!healthGate?.recentFailureWindowMs) {
      return 0;
    }

    const lastOutcome = instance.metadata.lastRegistrationOutcome?.trim().toLowerCase();
    if (lastOutcome !== "failure") {
      return 0;
    }

    const observedAtMs = parseTimestampMs(instance.metadata.lastRegistrationOutcomeAt);
    if (observedAtMs == null) {
      return 0;
    }

    const ageMs = Math.max(0, nowMs - observedAtMs);
    if (ageMs > healthGate.recentFailureWindowMs) {
      return 0;
    }

    return Math.max(0, healthGate.recentFailurePenalty ?? 0.12);
  }

  private resolveRoutingProfile(id: string | undefined): RoutingProfileLookup | undefined {
    const normalized = id?.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    return this.routingProfiles.get(normalized);
  }

  private resolveRequestedDomain(request: VerificationMailboxRequest): string | undefined {
    return request.requestedDomain?.trim().toLowerCase()
      || request.metadata?.requestedDomain?.trim().toLowerCase()
      || request.metadata?.mailcreateDomain?.trim().toLowerCase()
      || undefined;
  }

  private isRecoverableStrategyError(error: unknown): error is EasyEmailError {
    return error instanceof EasyEmailError && [
      "PROVIDER_INSTANCE_UNAVAILABLE",
      "CLOUDFLARE_TEMP_EMAIL_INSTANCE_UNAVAILABLE",
      "PROVIDER_SELECTION_FAILED",
    ].includes(error.code);
  }
}
