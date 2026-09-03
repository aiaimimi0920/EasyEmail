import { resolveNextUtcResetAt, resolveUtcResetWindowKey } from "./cooldown-window.js";
import {
  CRITICAL_CREDENTIAL_FAILURE_THRESHOLD,
  type CredentialAvailabilitySummary,
  type CredentialCooldownMode,
  type CredentialItemDefinition,
  type CredentialItemStatus,
  type CredentialSelection,
  type CredentialSetDefinition,
  type CredentialSummary,
  type CredentialUseCase,
} from "./credential-models.js";

interface CredentialRuntimeState {
  status?: CredentialItemStatus;
  cooldownUntilEpochMs?: number;
  lastError?: string;
  cooldownMode?: CredentialCooldownMode;
  criticalFailureCount?: number;
}

const runtimeState = new Map<string, CredentialRuntimeState>();
const roundRobinCounters = new Map<string, number>();
let runtimeResetWindowKey = resolveUtcResetWindowKey(new Date());

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function createRuntimeKey(namespace: string, setId: string, itemId: string): string {
  return `${namespace}::${setId}::${itemId}`;
}

function createRoundRobinKey(namespace: string, setId: string): string {
  return `${namespace}::${setId}`;
}

function ensureRuntimeStateFresh(nowEpochMs = Date.now()): void {
  const nextWindowKey = resolveUtcResetWindowKey(new Date(nowEpochMs));
  if (nextWindowKey === runtimeResetWindowKey) {
    return;
  }

  runtimeResetWindowKey = nextWindowKey;
  for (const [key, state] of runtimeState.entries()) {
    const status = state.status;
    const cooldownUntilEpochMs = state.cooldownUntilEpochMs;
    const hasFutureCooldown = cooldownUntilEpochMs !== undefined && cooldownUntilEpochMs > nowEpochMs;

    if (status === "invalid" || status === "disabled" || status === "exhausted" || hasFutureCooldown) {
      continue;
    }

    runtimeState.delete(key);
  }
  roundRobinCounters.clear();
}

export function clearCredentialRuntimeState(): void {
  runtimeResetWindowKey = resolveUtcResetWindowKey(new Date());
  runtimeState.clear();
  roundRobinCounters.clear();
}

function resolveExplicitItemStatus(item: CredentialItemDefinition, nowEpochMs: number): CredentialItemStatus {
  if (item.status === "disabled" || item.status === "invalid" || item.status === "exhausted") {
    return item.status;
  }

  if (item.cooldownUntil) {
    const until = Date.parse(item.cooldownUntil);
    if (Number.isFinite(until) && until > nowEpochMs) {
      return item.status === "rate-limited" ? "rate-limited" : "cooling";
    }
  }

  return item.status ?? "active";
}

export function getCredentialItemStatus(
  namespace: string,
  set: CredentialSetDefinition,
  item: CredentialItemDefinition,
  nowEpochMs = Date.now(),
): CredentialItemStatus {
  ensureRuntimeStateFresh(nowEpochMs);
  const explicit = resolveExplicitItemStatus(item, nowEpochMs);
  if (explicit === "disabled" || explicit === "invalid" || explicit === "exhausted") {
    return explicit;
  }

  const state = runtimeState.get(createRuntimeKey(namespace, set.id, item.id));
  if (state?.status === "invalid" || state?.status === "disabled" || state?.status === "exhausted") {
    return state.status;
  }
  if (state?.cooldownUntilEpochMs && state.cooldownUntilEpochMs > nowEpochMs) {
    return state.status === "rate-limited" ? "rate-limited" : "cooling";
  }

  return explicit;
}

function isCredentialItemAvailable(
  namespace: string,
  set: CredentialSetDefinition,
  item: CredentialItemDefinition,
  nowEpochMs = Date.now(),
): boolean {
  const status = getCredentialItemStatus(namespace, set, item, nowEpochMs);
  return status === "active";
}

export function selectCredentialItem(options: {
  namespace: string;
  sets: CredentialSetDefinition[];
  useCase: CredentialUseCase;
  stickyKey?: string;
}): CredentialSelection | undefined {
  const { namespace, useCase, stickyKey } = options;
  const nowEpochMs = Date.now();
  ensureRuntimeStateFresh(nowEpochMs);
  const candidateSets = [...options.sets]
    .filter((set) => set.useCases.includes(useCase))
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.displayName.localeCompare(right.displayName));

  for (const set of candidateSets) {
    const items = [...set.items]
      .filter((item) => isCredentialItemAvailable(namespace, set, item, nowEpochMs))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.label.localeCompare(right.label));

    if (items.length === 0) {
      continue;
    }

    const strategy = set.strategy ?? "round-robin";
    if (strategy === "first-active") {
      return { set, item: items[0]! };
    }

    if (strategy === "sticky-per-host" && stickyKey) {
      return { set, item: items[hashString(`${set.id}:${stickyKey}`) % items.length]! };
    }

    const counterKey = createRoundRobinKey(namespace, set.id);
    const nextIndex = roundRobinCounters.get(counterKey) ?? 0;
    roundRobinCounters.set(counterKey, nextIndex + 1);
    return { set, item: items[nextIndex % items.length]! };
  }

  return undefined;
}

export function markCredentialSuccess(namespace: string, set: CredentialSetDefinition, item: CredentialItemDefinition): void {
  ensureRuntimeStateFresh();
  runtimeState.delete(createRuntimeKey(namespace, set.id, item.id));
}

export function markCredentialCriticalFailure(
  namespace: string,
  set: CredentialSetDefinition,
  item: CredentialItemDefinition,
  input: {
    status?: CredentialItemStatus;
    error?: string;
    threshold?: number;
    now?: Date;
  } = {},
): { cooled: boolean; failureCount: number } {
  const now = input.now ?? new Date();
  ensureRuntimeStateFresh(now.getTime());
  const key = createRuntimeKey(namespace, set.id, item.id);
  const previous = runtimeState.get(key);
  const failureCount = Math.max(0, previous?.criticalFailureCount ?? 0) + 1;
  const threshold = Math.max(1, input.threshold ?? CRITICAL_CREDENTIAL_FAILURE_THRESHOLD);

  if (failureCount >= threshold) {
    runtimeState.set(key, {
      status: input.status ?? "rate-limited",
      cooldownUntilEpochMs: resolveNextUtcResetAt(now).getTime(),
      lastError: input.error,
      cooldownMode: "until-reset-window",
      criticalFailureCount: failureCount,
    });
    return {
      cooled: true,
      failureCount,
    };
  }

  runtimeState.set(key, {
    status: undefined,
    cooldownUntilEpochMs: undefined,
    lastError: input.error,
    cooldownMode: undefined,
    criticalFailureCount: failureCount,
  });
  return {
    cooled: false,
    failureCount,
  };
}

export function markCredentialFailure(
  namespace: string,
  set: CredentialSetDefinition,
  item: CredentialItemDefinition,
  input: {
    status?: CredentialItemStatus;
    cooldownMs?: number;
    error?: string;
    cooldownUntilEpochMs?: number;
    cooldownMode?: CredentialCooldownMode;
  } = {},
): void {
  ensureRuntimeStateFresh();
  const key = createRuntimeKey(namespace, set.id, item.id);
  const status = input.status ?? "cooling";
  const cooldownUntilEpochMs = input.cooldownUntilEpochMs;
  const cooldownMs = input.cooldownMs ?? (status === "rate-limited" ? 5 * 60_000 : 60_000);
  const cooldownMode = input.cooldownMode ?? (cooldownUntilEpochMs !== undefined ? "until-reset-window" : "duration");
  runtimeState.set(key, {
    status,
    cooldownUntilEpochMs: status === "invalid" || status === "disabled" || status === "exhausted"
      ? undefined
      : (cooldownUntilEpochMs ?? (Date.now() + Math.max(0, cooldownMs))),
    lastError: input.error,
    cooldownMode,
    criticalFailureCount: 0,
  });
}

export function markCredentialCooldownUntilNextResetWindow(
  namespace: string,
  set: CredentialSetDefinition,
  item: CredentialItemDefinition,
  input: {
    status?: CredentialItemStatus;
    error?: string;
    now?: Date;
  } = {},
): void {
  const now = input.now ?? new Date();
  markCredentialFailure(namespace, set, item, {
    status: input.status ?? "rate-limited",
    error: input.error,
    cooldownUntilEpochMs: resolveNextUtcResetAt(now).getTime(),
    cooldownMode: "until-reset-window",
  });
}

export function getCredentialAvailabilitySummary(
  namespace: string,
  sets: CredentialSetDefinition[],
  useCase?: CredentialUseCase,
): CredentialAvailabilitySummary {
  ensureRuntimeStateFresh();
  const nowEpochMs = Date.now();
  const summary: CredentialAvailabilitySummary = {
    configuredCount: 0,
    availableCount: 0,
    coolingCount: 0,
    rateLimitedCount: 0,
    exhaustedCount: 0,
    invalidCount: 0,
    disabledCount: 0,
    resetWindowCoolingCount: 0,
    timedCoolingCount: 0,
  };

  for (const set of sets) {
    if (useCase && set.useCases.includes(useCase) === false) {
      continue;
    }

    for (const item of set.items) {
      summary.configuredCount += 1;
      const status = getCredentialItemStatus(namespace, set, item, nowEpochMs);
      const state = runtimeState.get(createRuntimeKey(namespace, set.id, item.id));
      if (status === "active") summary.availableCount += 1;
      if (status === "cooling") summary.coolingCount += 1;
      if (status === "rate-limited") summary.rateLimitedCount += 1;
      if (status === "exhausted") summary.exhaustedCount += 1;
      if (status === "invalid") summary.invalidCount += 1;
      if (status === "disabled") summary.disabledCount += 1;
      if ((status === "cooling" || status === "rate-limited") && state?.cooldownMode === "until-reset-window") {
        summary.resetWindowCoolingCount += 1;
      }
      if ((status === "cooling" || status === "rate-limited") && state?.cooldownMode !== "until-reset-window") {
        summary.timedCoolingCount += 1;
      }
    }
  }

  return summary;
}

export function buildCredentialSummary(namespace: string, sets: CredentialSetDefinition[]): CredentialSummary {
  ensureRuntimeStateFresh();
  const summary: CredentialSummary = {
    setCount: sets.length,
    itemCount: 0,
    activeCount: 0,
    coolingCount: 0,
    rateLimitedCount: 0,
    exhaustedCount: 0,
    invalidCount: 0,
    disabledCount: 0,
    labels: [],
  };

  for (const set of sets) {
    summary.labels.push(set.displayName);
    for (const item of set.items) {
      summary.itemCount += 1;
      const status = getCredentialItemStatus(namespace, set, item);
      if (status === "active") summary.activeCount += 1;
      if (status === "cooling") summary.coolingCount += 1;
      if (status === "rate-limited") summary.rateLimitedCount += 1;
      if (status === "exhausted") summary.exhaustedCount += 1;
      if (status === "invalid") summary.invalidCount += 1;
      if (status === "disabled") summary.disabledCount += 1;
    }
  }

  return summary;
}

export function serializeCredentialSummary(summary: CredentialSummary): string {
  return JSON.stringify(summary);
}
