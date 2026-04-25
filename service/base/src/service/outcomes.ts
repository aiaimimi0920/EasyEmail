import { clamp } from "../shared/index.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxSession,
  ProviderInstance,
} from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";
import {
  clearProviderInstanceCriticalFailures,
  markProviderInstanceCriticalFailure,
  synchronizeProviderOperationalState,
} from "./provider-operational-state.js";

export interface DomainPerformanceStats {
  successCount: number;
  failureCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export interface ProviderPerformanceStats {
  successCount: number;
  failureCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  domains: Record<string, DomainPerformanceStats>;
}

export type MailboxFailureClass = "capacity" | "transient" | "delivery" | "auth" | "unknown";

export function extractEmailDomain(emailAddress: string | undefined): string | undefined {
  const value = String(emailAddress || "").trim().toLowerCase();
  if (!value || !value.includes("@")) {
    return undefined;
  }

  const domain = value.split("@", 2)[1]?.trim().toLowerCase();
  return domain || undefined;
}

export function parseProviderPerformanceStats(raw: string | undefined): ProviderPerformanceStats {
  if (!raw?.trim()) {
    return {
      successCount: 0,
      failureCount: 0,
      domains: {},
    };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const domainsRaw = parsed.domains;
    const domains = domainsRaw && typeof domainsRaw === "object" && Array.isArray(domainsRaw) === false
      ? Object.fromEntries(
          Object.entries(domainsRaw).map(([key, value]) => {
            const entry = value && typeof value === "object" && Array.isArray(value) === false
              ? value as Record<string, unknown>
              : {};
            return [key, {
              successCount: Math.max(0, Number.parseInt(String(entry.successCount ?? "0"), 10) || 0),
              failureCount: Math.max(0, Number.parseInt(String(entry.failureCount ?? "0"), 10) || 0),
              lastSuccessAt: typeof entry.lastSuccessAt === "string" ? entry.lastSuccessAt : undefined,
              lastFailureAt: typeof entry.lastFailureAt === "string" ? entry.lastFailureAt : undefined,
            }];
          }),
        )
      : {};

    return {
      successCount: Math.max(0, Number.parseInt(String(parsed.successCount ?? "0"), 10) || 0),
      failureCount: Math.max(0, Number.parseInt(String(parsed.failureCount ?? "0"), 10) || 0),
      lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : undefined,
      lastFailureAt: typeof parsed.lastFailureAt === "string" ? parsed.lastFailureAt : undefined,
      domains,
    };
  } catch {
    return {
      successCount: 0,
      failureCount: 0,
      domains: {},
    };
  }
}

function updateProviderPerformanceStats(
  current: ProviderPerformanceStats,
  input: {
    success: boolean;
    observedAt: string;
    domain?: string;
  },
): ProviderPerformanceStats {
  const next: ProviderPerformanceStats = {
    successCount: current.successCount,
    failureCount: current.failureCount,
    lastSuccessAt: current.lastSuccessAt,
    lastFailureAt: current.lastFailureAt,
    domains: Object.fromEntries(
      Object.entries(current.domains).map(([key, value]) => [key, { ...value }]),
    ),
  };

  if (input.success) {
    next.successCount += 1;
    next.lastSuccessAt = input.observedAt;
  } else {
    next.failureCount += 1;
    next.lastFailureAt = input.observedAt;
  }

  if (input.domain) {
    const domainStats = next.domains[input.domain] ?? {
      successCount: 0,
      failureCount: 0,
    };
    if (input.success) {
      domainStats.successCount += 1;
      domainStats.lastSuccessAt = input.observedAt;
    } else {
      domainStats.failureCount += 1;
      domainStats.lastFailureAt = input.observedAt;
    }
    next.domains[input.domain] = domainStats;
  }

  return next;
}

function adjustOutcomeWeightedHealthScore(currentScore: number, success: boolean): number {
  if (success) {
    return clamp(currentScore + (1 - currentScore) * 0.12, 0.1, 1);
  }

  return clamp(currentScore * 0.82, 0.1, 1);
}

export function classifyMailboxFailure(reason: string | undefined): MailboxFailureClass {
  const normalized = String(reason ?? "").trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }

  if (
    normalized.includes("status 429")
    || normalized.includes("too many requests")
    || normalized.includes("rate limit")
    || normalized.includes("quota")
    || normalized.includes("capacity")
    || normalized.includes("最大邮箱数量限制")
    || normalized.includes("已达到最大邮箱数量限制")
    || normalized.includes("maximum mailbox")
    || normalized.includes("max mailbox")
    || normalized.includes("mailbox count limit")
  ) {
    return "capacity";
  }

  if (
    normalized.includes("otp_timeout")
    || normalized.includes("code never arrived")
    || normalized.includes("mailbox")
    || normalized.includes("delivery")
  ) {
    return "delivery";
  }

  if (
    normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("invalid token")
    || normalized.includes("auth")
    || normalized.includes("credential")
  ) {
    return "auth";
  }

  if (
    normalized.includes("fetch failed")
    || normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("econnreset")
    || normalized.includes("socket hang up")
    || normalized.includes("network")
    || normalized.includes("transient")
    || normalized.includes("status 5")
  ) {
    return "transient";
  }

  return "unknown";
}

function parseConsecutiveFailureCount(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveFailureCooldownUntil(failureClass: MailboxFailureClass, now: Date): string | undefined {
  const minutes = failureClass === "capacity"
    ? 45
    : failureClass === "transient"
      ? 15
      : failureClass === "delivery"
        ? 10
        : failureClass === "auth"
          ? 90
          : 5;
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

function supportsCredentialRuntimeCooldown(registry: MailRegistry, instance: ProviderInstance): boolean {
  return registry.resolveCredentialSetsForInstance(instance.id, "generate").length > 0
    || registry.resolveCredentialSetsForInstance(instance.id, "poll").length > 0;
}

function applyProviderCriticalFailureState(
  registry: MailRegistry,
  instance: ProviderInstance,
  failureClass: MailboxFailureClass,
  now: Date,
): ProviderInstance {
  if (supportsCredentialRuntimeCooldown(registry, instance)) {
    return clearProviderInstanceCriticalFailures(instance, now);
  }

  if (failureClass !== "capacity") {
    return clearProviderInstanceCriticalFailures(instance, now);
  }

  return markProviderInstanceCriticalFailure(instance, {
    reason: "provider_capacity_exhausted",
    now,
  }).instance;
}

export function recordMailboxOpenFailure(
  registry: MailRegistry,
  instance: ProviderInstance,
  error: unknown,
  now: Date,
): void {
  const observedAt = now.toISOString();
  const failureReason = error instanceof Error ? error.message : String(error);
  const failureClass = classifyMailboxFailure(failureReason);
  const stats = updateProviderPerformanceStats(
    parseProviderPerformanceStats(instance.metadata.registrationStatsJson),
    {
      success: false,
      observedAt,
      domain: extractEmailDomain(instance.metadata.domain),
    },
  );
  const consecutiveFailureCount = parseConsecutiveFailureCount(instance.metadata.consecutiveFailureCount) + 1;
  const nextInstance: ProviderInstance = {
    ...instance,
    status: instance.status === "offline" ? "offline" : "degraded",
    healthScore: adjustOutcomeWeightedHealthScore(instance.healthScore, false),
    updatedAt: observedAt,
    metadata: {
      ...instance.metadata,
      registrationStatsJson: JSON.stringify(stats),
      lastRegistrationOutcome: "failure",
      lastRegistrationOutcomeAt: observedAt,
      lastRegistrationFailureReason: failureReason,
      lastFailureClass: failureClass,
      consecutiveFailureCount: String(consecutiveFailureCount),
      cooldownUntil: resolveFailureCooldownUntil(failureClass, now),
    },
  };
  const cooledInstance = applyProviderCriticalFailureState(registry, nextInstance, failureClass, now);
  registry.saveInstance(cooledInstance);
  synchronizeProviderOperationalState(registry, now);
}

export function reportMailboxOutcomeToRegistry(
  registry: MailRegistry,
  report: MailboxOutcomeReport,
  now: Date,
): MailboxOutcomeReportResult {
  const session = registry.findSessionById(report.sessionId);
  if (!session) {
    throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${report.sessionId}.`);
  }

  const instance = registry.findInstanceById(session.providerInstanceId);
  if (!instance) {
    throw new EasyEmailError(
      "PROVIDER_INSTANCE_NOT_FOUND",
      `Unknown provider instance for mailbox session ${report.sessionId}: ${session.providerInstanceId}.`,
    );
  }

  const observedAt = report.observedAt?.trim() || now.toISOString();
  const selectedDomain = session.metadata.selectedDomain || extractEmailDomain(session.emailAddress);
  const stats = updateProviderPerformanceStats(
    parseProviderPerformanceStats(instance.metadata.registrationStatsJson),
    {
      success: report.success,
      observedAt,
      domain: selectedDomain,
    },
  );
  const failureReason = report.failureReason?.trim();
  const failureClass = classifyMailboxFailure(failureReason);

  const nextInstance: ProviderInstance = {
    ...instance,
    status: report.success
      ? "active"
      : (instance.status === "offline" ? "offline" : "degraded"),
    healthScore: adjustOutcomeWeightedHealthScore(instance.healthScore, report.success),
    updatedAt: observedAt,
    metadata: {
      ...instance.metadata,
      registrationStatsJson: JSON.stringify(stats),
      lastRegistrationOutcome: report.success ? "success" : "failure",
      lastRegistrationOutcomeAt: observedAt,
      ...(failureReason
        ? { lastRegistrationFailureReason: failureReason }
        : {}),
      ...(report.success
        ? {
            consecutiveFailureCount: "0",
            cooldownUntil: "",
            lastFailureClass: "",
          }
        : {
            lastFailureClass: failureClass,
            consecutiveFailureCount: String(parseConsecutiveFailureCount(instance.metadata.consecutiveFailureCount) + 1),
            cooldownUntil: resolveFailureCooldownUntil(failureClass, now),
          }),
    },
  };
  const cooledInstance = report.success
    ? clearProviderInstanceCriticalFailures(nextInstance, now)
    : applyProviderCriticalFailureState(registry, nextInstance, failureClass, now);
  registry.saveInstance(cooledInstance);
  synchronizeProviderOperationalState(registry, now);

  const nextSession: MailboxSession = {
    ...session,
    metadata: {
      ...session.metadata,
      registrationOutcome: report.success ? "success" : "failure",
      registrationOutcomeAt: observedAt,
      ...(selectedDomain ? { selectedDomain } : {}),
      ...(report.failureReason?.trim()
        ? { registrationFailureReason: report.failureReason.trim() }
        : {}),
      ...(report.registrationMode?.trim()
        ? { registrationMode: report.registrationMode.trim() }
        : {}),
      ...(report.source?.trim()
        ? { registrationOutcomeSource: report.source.trim() }
        : {}),
    },
  };
  registry.saveSession(nextSession);

  return {
    session: nextSession,
    instance: registry.findInstanceById(cooledInstance.id) ?? cooledInstance,
    providerTypeKey: cooledInstance.providerTypeKey,
    providerInstanceId: cooledInstance.id,
    healthScore: (registry.findInstanceById(cooledInstance.id) ?? cooledInstance).healthScore,
    selectedDomain,
  };
}
