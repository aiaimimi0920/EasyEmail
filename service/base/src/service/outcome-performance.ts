import { clamp } from "../shared/index.js";

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

type PerformanceUpdate = {
  success: boolean;
  observedAt: string;
  domain?: string;
};

function cloneProviderPerformanceStats(current: ProviderPerformanceStats): ProviderPerformanceStats {
  return {
    ...current,
    domains: Object.fromEntries(
      Object.entries(current.domains).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function updateDomainPerformanceStats(
  next: ProviderPerformanceStats,
  input: PerformanceUpdate,
): void {
  if (!input.domain) {
    return;
  }

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

export function updateProviderPerformanceStats(
  current: ProviderPerformanceStats,
  input: PerformanceUpdate,
): ProviderPerformanceStats {
  const next = cloneProviderPerformanceStats(current);
  if (input.success) {
    next.successCount += 1;
    next.lastSuccessAt = input.observedAt;
  } else {
    next.failureCount += 1;
    next.lastFailureAt = input.observedAt;
  }
  updateDomainPerformanceStats(next, input);
  return next;
}

export function updateProviderDomainPerformanceStats(
  current: ProviderPerformanceStats,
  input: PerformanceUpdate,
): ProviderPerformanceStats {
  const next = cloneProviderPerformanceStats(current);
  updateDomainPerformanceStats(next, input);
  return next;
}

export function adjustOutcomeWeightedHealthScore(currentScore: number, success: boolean): number {
  if (success) {
    return clamp(currentScore + (1 - currentScore) * 0.12, 0.1, 1);
  }

  return clamp(currentScore * 0.82, 0.1, 1);
}
