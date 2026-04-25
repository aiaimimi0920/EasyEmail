import { readFileSync } from "node:fs";
import { resolveNextUtcResetAt, resolveUtcResetWindowKey } from "./cooldown-window.js";

export type CredentialUseCase = "generate" | "poll" | "checkout";

export type CredentialSelectionStrategy = "first-active" | "round-robin" | "sticky-per-host";
export type CredentialCooldownMode = "duration" | "until-reset-window";
export const CRITICAL_CREDENTIAL_FAILURE_THRESHOLD = 3;

export type CredentialItemStatus =
  | "active"
  | "cooling"
  | "rate-limited"
  | "exhausted"
  | "invalid"
  | "disabled";

export interface CredentialItemDefinition {
  id: string;
  label: string;
  value?: string;
  username?: string;
  password?: string;
  usernameTemplate?: string;
  passwordTemplate?: string;
  priority?: number;
  weight?: number;
  status?: CredentialItemStatus;
  cooldownUntil?: string;
  metadata?: Record<string, string>;
}

export interface CredentialSetDefinition {
  id: string;
  displayName: string;
  useCases: CredentialUseCase[];
  strategy?: CredentialSelectionStrategy;
  priority?: number;
  items: CredentialItemDefinition[];
  metadata?: Record<string, string>;
}

export interface CredentialSelection {
  set: CredentialSetDefinition;
  item: CredentialItemDefinition;
}

export interface CredentialSummary {
  setCount: number;
  itemCount: number;
  activeCount: number;
  coolingCount: number;
  rateLimitedCount: number;
  exhaustedCount: number;
  invalidCount: number;
  disabledCount: number;
  labels: string[];
}

interface CredentialRuntimeState {
  status?: CredentialItemStatus;
  cooldownUntilEpochMs?: number;
  lastError?: string;
  cooldownMode?: CredentialCooldownMode;
  criticalFailureCount?: number;
}

export interface CredentialAvailabilitySummary {
  configuredCount: number;
  availableCount: number;
  coolingCount: number;
  rateLimitedCount: number;
  exhaustedCount: number;
  invalidCount: number;
  disabledCount: number;
  resetWindowCoolingCount: number;
  timedCoolingCount: number;
}

const runtimeState = new Map<string, CredentialRuntimeState>();
const roundRobinCounters = new Map<string, number>();
let runtimeResetWindowKey = resolveUtcResetWindowKey(new Date());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function toStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      output[key] = item;
    }
  }
  return output;
}

function normalizeUseCases(value: unknown): CredentialUseCase[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: CredentialUseCase[] = [];
  for (const item of value) {
    if (item === "generate" || item === "poll" || item === "checkout") {
      output.push(item);
    }
  }
  return output;
}

function normalizeStrategy(value: unknown): CredentialSelectionStrategy | undefined {
  if (
    value === "first-active"
    || value === "round-robin"
    || value === "sticky-per-host"
  ) {
    return value;
  }
  return undefined;
}

function normalizeStatus(value: unknown): CredentialItemStatus | undefined {
  if (
    value === "active"
    || value === "cooling"
    || value === "rate-limited"
    || value === "exhausted"
    || value === "invalid"
    || value === "disabled"
  ) {
    return value;
  }
  return undefined;
}

function toInteger(value: unknown, fallback: number | undefined = undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

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

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function toCredentialItem(rawItem: unknown, index: number): CredentialItemDefinition | undefined {
  if (!isRecord(rawItem)) {
    return undefined;
  }

  const itemId = typeof rawItem.id === "string" && rawItem.id.trim()
    ? rawItem.id.trim()
    : `item-${index + 1}`;
  const label = typeof rawItem.label === "string" && rawItem.label.trim()
    ? rawItem.label.trim()
    : itemId;

  return {
    id: itemId,
    label,
    value: typeof rawItem.value === "string" && rawItem.value.trim() ? rawItem.value.trim() : undefined,
    username: typeof rawItem.username === "string" && rawItem.username.trim() ? rawItem.username.trim() : undefined,
    password: typeof rawItem.password === "string" && rawItem.password.trim() ? rawItem.password.trim() : undefined,
    usernameTemplate: typeof rawItem.usernameTemplate === "string" && rawItem.usernameTemplate.trim()
      ? rawItem.usernameTemplate.trim()
      : undefined,
    passwordTemplate: typeof rawItem.passwordTemplate === "string" && rawItem.passwordTemplate.trim()
      ? rawItem.passwordTemplate.trim()
      : undefined,
    priority: toInteger(rawItem.priority),
    weight: toInteger(rawItem.weight),
    status: normalizeStatus(rawItem.status),
    cooldownUntil: typeof rawItem.cooldownUntil === "string" && rawItem.cooldownUntil.trim()
      ? rawItem.cooldownUntil.trim()
      : undefined,
    metadata: toStringMap(rawItem.metadata),
  };
}

export function maskCredentialSecret(secret: string | undefined, visible = 4): string {
  const value = (secret || "").trim();
  if (!value) {
    return "";
  }
  if (value.length <= visible * 2) {
    return value;
  }
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

export function parseCredentialSetsJson(raw: string | undefined): CredentialSetDefinition[] {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const source = Array.isArray(parsed) ? parsed : [parsed];
    const sets: CredentialSetDefinition[] = [];

    for (const rawSet of source) {
      if (!isRecord(rawSet)) {
        continue;
      }

      const itemsSource = Array.isArray(rawSet.items) ? rawSet.items : [];
      const items: CredentialItemDefinition[] = itemsSource
        .map((rawItem, index) => toCredentialItem(rawItem, index))
        .filter(isDefined);

      if (items.length === 0) {
        continue;
      }

      const setId = typeof rawSet.id === "string" && rawSet.id.trim()
        ? rawSet.id.trim()
        : `set-${sets.length + 1}`;
      const useCases = normalizeUseCases(rawSet.useCases);

      sets.push({
        id: setId,
        displayName: typeof rawSet.displayName === "string" && rawSet.displayName.trim()
          ? rawSet.displayName.trim()
          : setId,
        useCases: useCases.length > 0 ? useCases : ["generate", "poll", "checkout"],
        strategy: normalizeStrategy(rawSet.strategy) ?? "round-robin",
        priority: toInteger(rawSet.priority, 0),
        items,
        metadata: toStringMap(rawSet.metadata),
      });
    }

    return sets;
  } catch {
    return [];
  }
}

export function clearCredentialRuntimeState(): void {
  runtimeResetWindowKey = resolveUtcResetWindowKey(new Date());
  runtimeState.clear();
  roundRobinCounters.clear();
}

function parseValueLine(line: string, index: number): CredentialItemDefinition | undefined {
  const parts = line.split("|").map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }

  const value = parts.length === 1 ? parts[0] : parts[parts.length - 1];
  const label = parts.length === 1 ? maskCredentialSecret(value) || `item-${index + 1}` : parts[0];
  return {
    id: `item-${index + 1}`,
    label,
    value,
    metadata: {},
  };
}

function parseBasicAuthLine(line: string, index: number): CredentialItemDefinition | undefined {
  const parts = line.split("|").map((item) => item.trim()).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  let label = `cred-${index + 1}`;
  let username = "";
  let password = "";

  if (parts.length >= 3) {
    [label, username, password] = [parts[0], parts[1], parts.slice(2).join("|")];
  } else {
    [username, password] = [parts[0], parts[1]];
    label = maskCredentialSecret(username) || label;
  }

  if (!username || !password) {
    return undefined;
  }

  return {
    id: `item-${index + 1}`,
    label,
    username,
    password,
    metadata: {},
  };
}

function parseProxyUrlLine(line: string, index: number): CredentialItemDefinition | undefined {
  const parts = line.split("|").map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }

  const rawUrl = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
  const explicitLabel = parts.length >= 2 ? parts[0] : undefined;

  const parsed = parseFlexibleProxyUrl(rawUrl);
  if (!parsed) {
    return undefined;
  }

  const label = explicitLabel || parsed.username || `${parsed.host}:${parsed.port}`;

  return {
    id: `item-${index + 1}`,
    label,
    username: parsed.username,
    password: parsed.password,
    metadata: {
      endpointUrl: parsed.endpointUrl,
      proxyProtocol: parsed.protocol,
      proxyHost: parsed.host,
      proxyPort: String(parsed.port),
    },
  };
}

function parseFlexibleProxyUrl(raw: string): {
  endpointUrl: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
} | undefined {
  const normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }

  const direct = tryParseProxyUrl(normalized);
  if (direct) {
    return direct;
  }

  const implicitHttp = tryParseProxyUrl(`http://${normalized}`);
  if (implicitHttp) {
    return implicitHttp;
  }

  const colonAuthMatch = normalized.match(/^([^:@\s]+):([^:@\s]+):([^:\s]+):(\d+)$/);
  if (colonAuthMatch) {
    const [, username, password, host, port] = colonAuthMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  const atPrefixMatch = normalized.match(/^([^:@\s]+):([^@\s]+)@([^:\s]+):(\d+)$/);
  if (atPrefixMatch) {
    const [, username, password, host, port] = atPrefixMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  const hostAtAuthMatch = normalized.match(/^([^:\s]+):(\d+)@([^:@\s]+):([^@\s]+)$/);
  if (hostAtAuthMatch) {
    const [, host, port, username, password] = hostAtAuthMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  const hostColonAuthMatch = normalized.match(/^([^:\s]+):(\d+):([^:@\s]+):([^@\s]+)$/);
  if (hostColonAuthMatch) {
    const [, host, port, username, password] = hostColonAuthMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  const hostDoubleHashAuthMatch = normalized.match(/^([^:\s]+):(\d+)##([^#\s]+)##(.+)$/);
  if (hostDoubleHashAuthMatch) {
    const [, host, port, username, password] = hostDoubleHashAuthMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  return undefined;
}

function tryParseProxyUrl(rawUrl: string): {
  endpointUrl: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
} | undefined {
  try {
    const url = new URL(rawUrl);
    const protocol = url.protocol.replace(/:$/, "").toLowerCase();
    if (!url.hostname || !url.port) {
      return undefined;
    }

    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    return {
      endpointUrl: rawUrl,
      protocol,
      host: url.hostname,
      port: Number(url.port),
      username,
      password,
    };
  } catch {
    return undefined;
  }
}

function parseCredentialLines(
  raw: string,
  parser: (line: string, index: number) => CredentialItemDefinition | undefined,
): CredentialItemDefinition[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parser(line, index))
    .filter((item): item is CredentialItemDefinition => item !== undefined);
}

export function createValueCredentialSetFromLines(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const items = parseCredentialLines(raw, parseValueLine);
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: options.id,
    displayName: options.displayName,
    useCases: options.useCases,
    strategy: options.strategy ?? "round-robin",
    priority: options.priority ?? 0,
    items,
    metadata: {},
  };
}

export function createBasicAuthCredentialSetFromLines(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const items = parseCredentialLines(raw, parseBasicAuthLine);
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: options.id,
    displayName: options.displayName,
    useCases: options.useCases,
    strategy: options.strategy ?? "round-robin",
    priority: options.priority ?? 0,
    items,
    metadata: {},
  };
}

export function createBasicAuthCredentialSetFromFile(
  path: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  if (!path?.trim()) {
    return undefined;
  }

  try {
    const text = readFileSync(path, { encoding: "utf-8" });
    const items = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith("#") === false)
      .map((line) => (line.includes("#") ? line.split("#", 1)[0]!.trim() : line))
      .filter(Boolean)
      .map((line, index) => parseBasicAuthLine(line, index))
      .filter((item): item is CredentialItemDefinition => item !== undefined);

    if (items.length === 0) {
      return undefined;
    }

    return {
      id: options.id,
      displayName: options.displayName,
      useCases: options.useCases,
      strategy: options.strategy ?? "round-robin",
      priority: options.priority ?? 0,
      items,
      metadata: {},
    };
  } catch {
    return undefined;
  }
}

export function createProxyUrlCredentialSetFromLines(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const items = parseCredentialLines(raw, parseProxyUrlLine);
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: options.id,
    displayName: options.displayName,
    useCases: options.useCases,
    strategy: options.strategy ?? "round-robin",
    priority: options.priority ?? 0,
    items,
    metadata: {},
  };
}

export function loadValueCredentialItemsFromFile(path: string | undefined): CredentialItemDefinition[] {
  if (!path?.trim()) {
    return [];
  }

  try {
    const text = readFileSync(path, { encoding: "utf-8" });
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith("#") === false)
      .filter((line) => line.toUpperCase().includes("[EXHAUSTED]") === false)
      .map((line) => (line.includes("#") ? line.split("#", 1)[0]!.trim() : line))
      .filter(Boolean)
      .map((line, index) => parseValueLine(line, index))
      .filter((item): item is CredentialItemDefinition => item !== undefined);
  } catch {
    return [];
  }
}

export function createValueCredentialSetFromFile(
  path: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  const items = loadValueCredentialItemsFromFile(path);
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: options.id,
    displayName: options.displayName,
    useCases: options.useCases,
    strategy: options.strategy ?? "round-robin",
    priority: options.priority ?? 0,
    items,
    metadata: {},
  };
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
