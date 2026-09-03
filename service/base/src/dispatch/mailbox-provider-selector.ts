import { EasyEmailError } from "../domain/errors.js";
import { normalizeMailProviderTypeKey } from "../domain/models.js";
import type {
  MailProviderTypeKey,
  MailStrategyModeResolution,
  ProviderInstance,
  ProviderTypeDefinition,
  StrategyProfile,
  VerificationMailboxRequest,
} from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";
import { getMailProviderTypeForGroup } from "../domain/strategy-mode.js";
import { CloudflareTempEmailRuntimeController } from "../providers/cloudflare_temp_email/control/index.js";
import { parseTimestampMs } from "../shared/utils.js";
import type { DispatchStrategyRegistry } from "../strategies/index.js";
import { isProviderRecoverabilityEligible } from "../service/mailbox-access-descriptor.js";
import { parseProviderPerformanceStats } from "../service/outcomes.js";
import {
  computeRecentMailboxFailurePenalty,
  instanceCanAvoidExcludedDomains,
  instanceSupportsRequestedDomain,
  isMailboxDomainRiskOutcome,
  normalizeDomain,
  parseNonNegativeInteger,
  resolveRequestExcludedDomains,
  resolveRequestedDomain,
  shouldSkipForStructuredMailboxOutcome,
} from "./mailbox-dispatcher-policy.js";

export interface ExternalSelection {
  instance: ProviderInstance;
  strategyProfile: StrategyProfile;
}

export interface RoutingProfileLookup {
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

export class MailboxProviderSelector {
  private readonly strategyModeRoundRobinCounters = new Map<string, number>();

  public constructor(
    private readonly registry: MailRegistry,
    private readonly strategyRegistry: DispatchStrategyRegistry,
    private readonly runtimeController: CloudflareTempEmailRuntimeController,
  ) {}

  public providerTypeSupportsRequestedDomain(
    providerTypeKey: MailProviderTypeKey,
    request: VerificationMailboxRequest,
    requestedDomain: string | undefined,
  ): boolean {
    const normalizedRequestedDomain = normalizeDomain(requestedDomain);
    if (!normalizedRequestedDomain) {
      return true;
    }

    const candidates = this.registry.listActiveInstancesByType(providerTypeKey).filter((instance) => {
      if (request.groupKey && instance.groupKeys.length > 0) {
        return instance.groupKeys.includes(request.groupKey);
      }
      return true;
    });
    if (candidates.length === 0) {
      return false;
    }

    return candidates.some((instance) => instanceSupportsRequestedDomain(instance, normalizedRequestedDomain));
  }

  public selectExternalInstance(
    providerType: ProviderTypeDefinition,
    request: VerificationMailboxRequest,
    now: Date,
    applyStructuredMailboxAvoidance = false,
  ): ExternalSelection {
    const nowMs = now.getTime();
    const candidates = this.listExternalInstanceCandidates(providerType.key, request, now)
      .filter((instance) => !applyStructuredMailboxAvoidance || !shouldSkipForStructuredMailboxOutcome(instance, nowMs));

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
      const requestedDomain = resolveRequestedDomain(request);
      throw new EasyEmailError(
        "PROVIDER_INSTANCE_UNAVAILABLE",
        requestedDomain
          ? `No active provider instance for ${providerType.displayName} can serve requested domain "${requestedDomain}".`
          : `No active provider instance is registered for ${providerType.displayName}.`,
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

  public resolveStrategyProfile(
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

  public createRuntimePlanIfAvailable(instance: ProviderInstance) {
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

  public buildProviderTypeOrder(
    strategyMode: MailStrategyModeResolution,
    request: VerificationMailboxRequest,
    now: Date,
    preferredProviderType?: MailProviderTypeKey,
    routingProfile?: RoutingProfileLookup,
  ): MailProviderTypeKey[] {
    const groups = strategyMode.modeId === "random"
      ? this.shuffleValues(strategyMode.providerGroupOrder, `mail:${strategyMode.providerSelections.join("|")}`)
      : strategyMode.modeId === "available-first"
        ? this.orderProviderGroupsByAvailability(strategyMode.providerSelections, request, now, routingProfile)
        : strategyMode.providerGroupOrder;
    const nowMs = now.getTime();
    const excludedProviderTypeKeys = new Set(
      (request.excludedProviderTypeKeys ?? [])
        .map((item) => normalizeMailProviderTypeKey(item))
        .filter((item): item is MailProviderTypeKey => item !== undefined),
    );
    const providerTypes = groups
      .map((group) => getMailProviderTypeForGroup(group))
      .filter((providerTypeKey) => !excludedProviderTypeKeys.has(providerTypeKey))
      .filter((providerTypeKey) => this.providerTypeMatchesRecoverabilityFilter(providerTypeKey, request, now))
      .filter((providerTypeKey) => !this.shouldSkipProviderTypeForStructuredMailboxOutcome(
        providerTypeKey,
        request,
        nowMs,
      ));

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
    for (let index = tail.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [tail[index], tail[swapIndex]] = [tail[swapIndex]!, tail[index]!];
    }
    return [head, ...tail];
  }

  private orderProviderGroupsByAvailability(
    providerGroups: MailStrategyModeResolution["providerSelections"],
    request: VerificationMailboxRequest,
    now: Date,
    routingProfile?: RoutingProfileLookup,
  ): MailStrategyModeResolution["providerSelections"] {
    const nowMs = now.getTime();
    const scores = new Map(providerGroups.map((group) => [
      group,
      this.computeProviderAvailabilityScore(
        getMailProviderTypeForGroup(group),
        request,
        nowMs,
        routingProfile?.healthGate,
      ),
    ]));
    const effectiveScores = [...scores.values()].some((value) => Number.isFinite(value))
      ? scores
      : new Map(providerGroups.map((group) => [
          group,
          this.computeProviderAvailabilityScore(getMailProviderTypeForGroup(group), request, nowMs),
        ]));
    return this.weightedShuffleProviderGroups(providerGroups, effectiveScores);
  }

  private weightedShuffleProviderGroups(
    providerGroups: MailStrategyModeResolution["providerSelections"],
    scores: Map<MailStrategyModeResolution["providerSelections"][number], number>,
  ): MailStrategyModeResolution["providerSelections"] {
    const finiteEntries = providerGroups
      .map((group) => ({
        group,
        score: scores.get(group) ?? Number.NEGATIVE_INFINITY,
      }))
      .filter((item) => Number.isFinite(item.score));
    const unavailable = providerGroups.filter((group) => !finiteEntries.some((item) => item.group === group));
    if (finiteEntries.length <= 1) {
      return [
        ...finiteEntries.map((item) => item.group),
        ...unavailable,
      ];
    }

    const minScore = Math.min(...finiteEntries.map((item) => item.score));
    const pool = finiteEntries.map((item) => ({
      group: item.group,
      weight: Math.max(0.05, item.score - minScore + 0.1),
    }));
    const ordered: MailStrategyModeResolution["providerSelections"] = [];

    while (pool.length > 0) {
      const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
      if (!(totalWeight > 0)) {
        ordered.push(...pool.map((item) => item.group));
        break;
      }
      let cursor = Math.random() * totalWeight;
      let selectedIndex = pool.length - 1;
      for (let index = 0; index < pool.length; index += 1) {
        cursor -= pool[index]!.weight;
        if (cursor <= 0) {
          selectedIndex = index;
          break;
        }
      }
      const [selected] = pool.splice(selectedIndex, 1);
      if (selected) {
        ordered.push(selected.group);
      }
    }

    return [...ordered, ...unavailable];
  }

  private computeProviderPerformanceScore(instance: ProviderInstance, nowMs: number): number {
    if (isMailboxDomainRiskOutcome(instance)) {
      return 0;
    }

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
    nowMs: number,
    healthGate?: RoutingProfileLookup["healthGate"],
  ): number {
    const candidates = this.listExternalInstanceCandidates(providerTypeKey, request, new Date(nowMs))
      .filter((instance) => !shouldSkipForStructuredMailboxOutcome(instance, nowMs));

    if (candidates.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }

    return candidates.reduce((best, instance) => {
      const isDomainRiskOutcome = isMailboxDomainRiskOutcome(instance);
      const consecutiveFailureCount = isDomainRiskOutcome
        ? 0
        : parseNonNegativeInteger(instance.metadata.consecutiveFailureCount);
      const effectiveHealthScore = isDomainRiskOutcome && healthGate?.minimumHealthScore !== undefined
        ? Math.max(instance.healthScore, healthGate.minimumHealthScore)
        : instance.healthScore;
      if (healthGate?.minimumHealthScore !== undefined && effectiveHealthScore < healthGate.minimumHealthScore) {
        return best;
      }
      if (healthGate?.maxConsecutiveFailures !== undefined && consecutiveFailureCount > healthGate.maxConsecutiveFailures) {
        return best;
      }

      const latencyPenalty = Math.min(Math.max(instance.averageLatencyMs, 0), 5_000) / 5_000 * 0.1;
      const statusBonus = isDomainRiskOutcome
        ? 0.03
        : instance.status === "active"
          ? 0.03
          : instance.status === "degraded"
            ? -0.03
            : 0;
      const recentFailurePenalty = computeRecentMailboxFailurePenalty(instance, nowMs);
      const performanceScore = this.computeProviderPerformanceScore(instance, nowMs);
      const gatePenalty = this.computeRecentFailureGatePenalty(instance, nowMs, healthGate);
      const score = effectiveHealthScore + statusBonus + performanceScore - latencyPenalty - recentFailurePenalty - gatePenalty;
      return Math.max(best, score);
    }, Number.NEGATIVE_INFINITY);
  }

  private listExternalInstanceCandidates(
    providerTypeKey: MailProviderTypeKey,
    request: VerificationMailboxRequest,
    now: Date = new Date(),
  ): ProviderInstance[] {
    const excludedDomains = resolveRequestExcludedDomains(request);
    return this.registry.listActiveInstancesByType(providerTypeKey).filter((instance) => {
      if (request.groupKey && instance.groupKeys.length > 0) {
        return instance.groupKeys.includes(request.groupKey);
      }
      return true;
    })
      .filter((instance) => instanceSupportsRequestedDomain(instance, resolveRequestedDomain(request)))
      .filter((instance) => instanceCanAvoidExcludedDomains(instance, excludedDomains))
      .filter((instance) => isProviderRecoverabilityEligible(
        instance,
        request.recoverabilityLevels,
        request.includeUndeterminedRecoverability,
        now,
      ));
  }

  private shouldSkipProviderTypeForStructuredMailboxOutcome(
    providerTypeKey: MailProviderTypeKey,
    request: VerificationMailboxRequest,
    nowMs: number,
  ): boolean {
    const candidates = this.listExternalInstanceCandidates(providerTypeKey, request, new Date(nowMs));
    return candidates.length > 0 && candidates.every((instance) => shouldSkipForStructuredMailboxOutcome(instance, nowMs));
  }

  public providerTypeMatchesRecoverabilityFilter(
    providerTypeKey: MailProviderTypeKey,
    request: VerificationMailboxRequest,
    now: Date,
  ): boolean {
    if (!request.recoverabilityLevels || request.recoverabilityLevels.length === 0) {
      return true;
    }

    const candidates = this.registry.listActiveInstancesByType(providerTypeKey).filter((instance) => {
      if (request.groupKey && instance.groupKeys.length > 0) {
        return instance.groupKeys.includes(request.groupKey);
      }
      return true;
    });
    if (candidates.length === 0) {
      return request.includeUndeterminedRecoverability === true;
    }

    return candidates.some((instance) => isProviderRecoverabilityEligible(
      instance,
      request.recoverabilityLevels,
      request.includeUndeterminedRecoverability,
      now,
    ));
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
    if (isMailboxDomainRiskOutcome(instance)) {
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
}
