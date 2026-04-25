import type { ProviderInstance, ProviderInstanceStatus } from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";
import { clearCredentialRuntimeState, getCredentialAvailabilitySummary } from "../shared/credentials.js";
import { resolveNextUtcResetAt } from "../shared/cooldown-window.js";
import { parseTimestampMs } from "../shared/utils.js";

const OPERATIONAL_COOLDOWN_UNTIL_KEY = "operationalCooldownUntil";
const OPERATIONAL_COOLDOWN_SCOPE_KEY = "operationalCooldownScope";
const OPERATIONAL_COOLDOWN_REASON_KEY = "operationalCooldownReason";
const OPERATIONAL_PREVIOUS_STATUS_KEY = "operationalPreviousStatus";
const OPERATIONAL_CRITICAL_FAILURE_COUNT_KEY = "operationalCriticalFailureCount";
const OPERATIONAL_CRITICAL_FAILURE_REASON_KEY = "operationalCriticalFailureReason";

export type ProviderOperationalCooldownScope = "provider" | "credentials";
export const CRITICAL_PROVIDER_FAILURE_THRESHOLD = 3;

function normalizeRestoredStatus(value: string | undefined): ProviderInstanceStatus {
  if (value === "active" || value === "degraded" || value === "offline" || value === "provisioning") {
    return value;
  }

  return "active";
}

function clearOperationalMetadata(metadata: Record<string, string>): Record<string, string> {
  const next = { ...metadata };
  delete next[OPERATIONAL_COOLDOWN_UNTIL_KEY];
  delete next[OPERATIONAL_COOLDOWN_SCOPE_KEY];
  delete next[OPERATIONAL_COOLDOWN_REASON_KEY];
  delete next[OPERATIONAL_PREVIOUS_STATUS_KEY];
  delete next[OPERATIONAL_CRITICAL_FAILURE_COUNT_KEY];
  delete next[OPERATIONAL_CRITICAL_FAILURE_REASON_KEY];
  return next;
}

function clearOperationalFailureTracking(metadata: Record<string, string>): Record<string, string> {
  const next = { ...metadata };
  delete next[OPERATIONAL_CRITICAL_FAILURE_COUNT_KEY];
  delete next[OPERATIONAL_CRITICAL_FAILURE_REASON_KEY];
  return next;
}

function hasManagedOperationalCooldown(instance: ProviderInstance): boolean {
  return instance.status === "cooling" || Boolean(instance.metadata[OPERATIONAL_COOLDOWN_UNTIL_KEY]?.trim());
}

function hasOperationalFailureTracking(instance: ProviderInstance): boolean {
  return Boolean(instance.metadata[OPERATIONAL_CRITICAL_FAILURE_COUNT_KEY]?.trim());
}

function hasActiveOperationalCooldown(instance: ProviderInstance, now: Date): boolean {
  const untilMs = parseTimestampMs(instance.metadata[OPERATIONAL_COOLDOWN_UNTIL_KEY]);
  return untilMs !== undefined && untilMs > now.getTime();
}

function hasCredentialAwareCooldown(instance: ProviderInstance): boolean {
  return instance.metadata[OPERATIONAL_COOLDOWN_SCOPE_KEY] === "credentials";
}

function hasProviderAwareCooldown(instance: ProviderInstance): boolean {
  return instance.metadata[OPERATIONAL_COOLDOWN_SCOPE_KEY] === "provider";
}

function parseCriticalFailureCount(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function markProviderInstanceCooling(
  instance: ProviderInstance,
  input: {
    scope: ProviderOperationalCooldownScope;
    reason: string;
    now?: Date;
  },
): ProviderInstance {
  if (instance.status === "offline" || instance.status === "provisioning") {
    return instance;
  }

  if (hasProviderAwareCooldown(instance) && hasActiveOperationalCooldown(instance, input.now ?? new Date())) {
    return instance;
  }

  const now = input.now ?? new Date();
  const previousStatus = instance.status === "cooling"
    ? normalizeRestoredStatus(instance.metadata[OPERATIONAL_PREVIOUS_STATUS_KEY])
    : instance.status;

  return {
    ...instance,
    status: "cooling",
    updatedAt: now.toISOString(),
    metadata: {
      ...clearOperationalMetadata(instance.metadata),
      [OPERATIONAL_COOLDOWN_UNTIL_KEY]: resolveNextUtcResetAt(now).toISOString(),
      [OPERATIONAL_COOLDOWN_SCOPE_KEY]: input.scope,
      [OPERATIONAL_COOLDOWN_REASON_KEY]: input.reason,
      [OPERATIONAL_PREVIOUS_STATUS_KEY]: previousStatus,
    },
  };
}

export function markProviderInstanceCriticalFailure(
  instance: ProviderInstance,
  input: {
    reason: string;
    now?: Date;
    threshold?: number;
  },
): { instance: ProviderInstance; cooled: boolean; failureCount: number } {
  if (instance.status === "offline" || instance.status === "provisioning") {
    return {
      instance,
      cooled: false,
      failureCount: 0,
    };
  }

  const now = input.now ?? new Date();
  const failureCount = parseCriticalFailureCount(instance.metadata[OPERATIONAL_CRITICAL_FAILURE_COUNT_KEY]) + 1;
  const threshold = Math.max(1, input.threshold ?? CRITICAL_PROVIDER_FAILURE_THRESHOLD);
  const trackedInstance: ProviderInstance = {
    ...instance,
    updatedAt: now.toISOString(),
    metadata: {
      ...clearOperationalFailureTracking(instance.metadata),
      [OPERATIONAL_CRITICAL_FAILURE_COUNT_KEY]: String(failureCount),
      [OPERATIONAL_CRITICAL_FAILURE_REASON_KEY]: input.reason,
    },
  };

  if (failureCount < threshold) {
    return {
      instance: trackedInstance,
      cooled: false,
      failureCount,
    };
  }

  return {
    instance: markProviderInstanceCooling(trackedInstance, {
      scope: "provider",
      reason: input.reason,
      now,
    }),
    cooled: true,
    failureCount,
  };
}

export function clearProviderInstanceCriticalFailures(
  instance: ProviderInstance,
  now: Date = new Date(),
): ProviderInstance {
  if (hasOperationalFailureTracking(instance) === false) {
    return instance;
  }

  return {
    ...instance,
    updatedAt: now.toISOString(),
    metadata: clearOperationalFailureTracking(instance.metadata),
  };
}

export function releaseProviderInstanceCooling(
  instance: ProviderInstance,
  now: Date = new Date(),
): ProviderInstance {
  if (hasManagedOperationalCooldown(instance) === false) {
    return instance;
  }

  return {
    ...instance,
    status: "active",
    updatedAt: now.toISOString(),
    metadata: clearOperationalMetadata(instance.metadata),
  };
}

export function synchronizeProviderOperationalState(
  registry: MailRegistry,
  now: Date = new Date(),
): ProviderInstance[] {
  const changed: ProviderInstance[] = [];

  for (const instance of registry.listInstances()) {
    let next = instance;

    if (hasManagedOperationalCooldown(next) && hasActiveOperationalCooldown(next, now) === false) {
      next = releaseProviderInstanceCooling(next, now);
    }

    if (next.status !== "offline" && next.status !== "provisioning" && hasProviderAwareCooldown(next) === false) {
      const credentialSets = registry.resolveCredentialSetsForInstance(next.id);
      const summary = getCredentialAvailabilitySummary(
        `mail:${next.providerTypeKey}:${next.id}`,
        credentialSets.filter((set) => set.useCases.some((useCase) => useCase === "generate" || useCase === "poll")),
      );
      const shouldCoolForCredentials = summary.configuredCount > 0
        && summary.availableCount === 0
        && summary.resetWindowCoolingCount > 0
        && summary.timedCoolingCount === 0;

      if (shouldCoolForCredentials) {
        next = markProviderInstanceCooling(next, {
          scope: "credentials",
          reason: "all_credentials_cooling",
          now,
        });
      } else if (hasCredentialAwareCooldown(next)) {
        next = releaseProviderInstanceCooling(next, now);
      }
    }

    if (next !== instance) {
      registry.saveInstance(next);
      changed.push(next);
    }
  }

  return changed;
}

export function resetProviderOperationalState(
  registry: MailRegistry,
  now: Date = new Date(),
): ProviderInstance[] {
  clearCredentialRuntimeState();
  const changed: ProviderInstance[] = [];

  for (const instance of registry.listInstances()) {
    if (hasManagedOperationalCooldown(instance) === false && hasOperationalFailureTracking(instance) === false) {
      continue;
    }

    const next = hasManagedOperationalCooldown(instance)
      ? releaseProviderInstanceCooling(instance, now)
      : clearProviderInstanceCriticalFailures(instance, now);
    registry.saveInstance(next);
    changed.push(next);
  }

  return changed;
}
