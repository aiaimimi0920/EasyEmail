import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";

const DDG_ALIAS_DEFAULT_DAILY_LIMIT = 150;
const DDG_ALIAS_DEFAULT_ERROR_COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface DdgAliasKeyPoolStateEntryDocument {
  tokenId?: unknown;
  usageDayKey?: unknown;
  usageCount?: unknown;
  cooldownUntil?: unknown;
  lastFailureReason?: unknown;
  lastFailureMessage?: unknown;
  lastSelectedAt?: unknown;
  updatedAt?: unknown;
}

interface DdgAliasKeyPoolStateDocument {
  version?: unknown;
  entries?: unknown;
}

interface DdgAliasKeyRecord {
  id: string;
  token: string;
  label: string;
  order: number;
}

interface DdgAliasKeyRuntimeState {
  usageDayKey?: string;
  usageCount: number;
  cooldownUntil?: string;
  lastFailureReason?: string;
  lastFailureMessage?: string;
  lastSelectedAt?: string;
  updatedAt?: string;
}

interface DdgAliasKeyEffectiveState extends DdgAliasKeyRuntimeState {
  cooldownActive: boolean;
  quotaReached: boolean;
}

export interface DdgAliasKeySelection {
  tokenId: string;
  token: string;
  label: string;
  usageCount: number;
}

export interface DdgAliasKeyAvailability {
  configuredCount: number;
  availableCount: number;
  exhaustedCount: number;
  coolingCount: number;
  hasConfiguredTokens: boolean;
  hasAvailableTokens: boolean;
  message?: string;
}

export interface DdgAliasKeyPoolOptions {
  tokens?: string[];
  stateFilePath?: string;
  dailyLimit?: number;
  errorCooldownMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return fallback;
}

function createTokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return token;
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function normalizeTokens(rawTokens: string[] = []): DdgAliasKeyRecord[] {
  const seenTokens = new Set<string>();
  const records: DdgAliasKeyRecord[] = [];

  for (const rawToken of rawTokens) {
    const token = rawToken.trim();
    if (!token || seenTokens.has(token)) {
      continue;
    }

    seenTokens.add(token);
    records.push({
      id: createTokenId(token),
      token,
      label: `ddg-key-${records.length + 1} (${maskToken(token)})`,
      order: records.length,
    });
  }

  return records;
}

function toLocalDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getNextLocalDayStart(date: Date): Date {
  const next = new Date(date.getTime());
  next.setHours(24, 0, 0, 0);
  return next;
}

function getParentDirectory(path: string): string | undefined {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex > 0 ? path.slice(0, separatorIndex) : undefined;
}

function ensureParentDirectory(path: string): void {
  const parentDirectory = getParentDirectory(path);
  if (parentDirectory && existsSync(parentDirectory) === false) {
    mkdirSync(parentDirectory, { recursive: true });
  }
}

function parseStateEntry(value: unknown): { tokenId: string; state: DdgAliasKeyRuntimeState } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const tokenId = toNonEmptyString(value.tokenId);
  if (!tokenId) {
    return undefined;
  }

  return {
    tokenId,
    state: {
      usageDayKey: toNonEmptyString(value.usageDayKey),
      usageCount: toNonNegativeInteger(value.usageCount, 0),
      cooldownUntil: toNonEmptyString(value.cooldownUntil),
      lastFailureReason: toNonEmptyString(value.lastFailureReason),
      lastFailureMessage: toNonEmptyString(value.lastFailureMessage),
      lastSelectedAt: toNonEmptyString(value.lastSelectedAt),
      updatedAt: toNonEmptyString(value.updatedAt),
    },
  };
}

function parseStateDocument(value: unknown): Map<string, DdgAliasKeyRuntimeState> {
  if (!isRecord(value)) {
    return new Map();
  }

  const entries = Array.isArray(value.entries) ? value.entries : [];
  const state = new Map<string, DdgAliasKeyRuntimeState>();

  for (const entry of entries) {
    const parsed = parseStateEntry(entry);
    if (!parsed) {
      continue;
    }

    state.set(parsed.tokenId, parsed.state);
  }

  return state;
}

function toStateDocument(stateByTokenId: Map<string, DdgAliasKeyRuntimeState>): DdgAliasKeyPoolStateDocument {
  const entries = [...stateByTokenId.entries()]
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([tokenId, state]) => ({
      tokenId,
      usageDayKey: state.usageDayKey,
      usageCount: state.usageCount,
      cooldownUntil: state.cooldownUntil,
      lastFailureReason: state.lastFailureReason,
      lastFailureMessage: state.lastFailureMessage,
      lastSelectedAt: state.lastSelectedAt,
      updatedAt: state.updatedAt,
    }));

  return {
    version: 1,
    entries,
  };
}

function compareIsoTimestamp(left: string | undefined, right: string | undefined): number {
  const leftTime = left ? Date.parse(left) : 0;
  const rightTime = right ? Date.parse(right) : 0;
  return leftTime - rightTime;
}

export class DdgAliasKeyPool {
  private readonly keys: DdgAliasKeyRecord[];

  private readonly stateByTokenId: Map<string, DdgAliasKeyRuntimeState>;

  private readonly dailyLimit: number;

  private readonly errorCooldownMs: number;

  private readonly stateFilePath?: string;

  public constructor(options: DdgAliasKeyPoolOptions = {}) {
    this.keys = normalizeTokens(options.tokens);
    this.dailyLimit = Math.max(1, options.dailyLimit ?? DDG_ALIAS_DEFAULT_DAILY_LIMIT);
    this.errorCooldownMs = Math.max(1000, options.errorCooldownMs ?? DDG_ALIAS_DEFAULT_ERROR_COOLDOWN_MS);
    this.stateFilePath = options.stateFilePath?.trim() || undefined;
    this.stateByTokenId = this.loadState();
  }

  public getAvailability(now: Date = new Date()): DdgAliasKeyAvailability {
    let availableCount = 0;
    let exhaustedCount = 0;
    let coolingCount = 0;

    for (const key of this.keys) {
      const state = this.resolveEffectiveState(key.id, now);
      if (state.quotaReached) {
        exhaustedCount += 1;
        continue;
      }
      if (state.cooldownActive) {
        coolingCount += 1;
        continue;
      }
      availableCount += 1;
    }

    const hasConfiguredTokens = this.keys.length > 0;
    const hasAvailableTokens = availableCount > 0;

    return {
      configuredCount: this.keys.length,
      availableCount,
      exhaustedCount,
      coolingCount,
      hasConfiguredTokens,
      hasAvailableTokens,
      message: !hasConfiguredTokens
        ? "DDG alias email is enabled but no DDG token is configured."
        : (hasAvailableTokens
          ? undefined
          : "No DDG alias token is currently available. All configured keys are cooling down or have reached today's limit."),
    };
  }

  public selectToken(now: Date = new Date(), excludedTokenIds: ReadonlySet<string> = new Set()): DdgAliasKeySelection | undefined {
    const candidates = this.keys
      .filter((key) => excludedTokenIds.has(key.id) === false)
      .map((key) => ({ key, state: this.resolveEffectiveState(key.id, now) }))
      .filter(({ state }) => state.quotaReached === false && state.cooldownActive === false)
      .sort((left, right) => {
        if (left.state.usageCount !== right.state.usageCount) {
          return left.state.usageCount - right.state.usageCount;
        }

        const lastSelectedComparison = compareIsoTimestamp(left.state.lastSelectedAt, right.state.lastSelectedAt);
        if (lastSelectedComparison !== 0) {
          return lastSelectedComparison;
        }

        return left.key.order - right.key.order;
      });

    const selected = candidates[0];
    if (!selected) {
      return undefined;
    }

    return {
      tokenId: selected.key.id,
      token: selected.key.token,
      label: selected.key.label,
      usageCount: selected.state.usageCount,
    };
  }

  public async recordSuccess(tokenId: string, now: Date = new Date()): Promise<void> {
    const current = this.resolveEffectiveState(tokenId, now);
    const usageDayKey = toLocalDayKey(now);
    const usageCount = current.usageDayKey === usageDayKey
      ? current.usageCount + 1
      : 1;
    const updatedAt = now.toISOString();

    this.stateByTokenId.set(tokenId, {
      usageDayKey,
      usageCount,
      cooldownUntil: usageCount >= this.dailyLimit ? getNextLocalDayStart(now).toISOString() : undefined,
      lastFailureReason: undefined,
      lastFailureMessage: undefined,
      lastSelectedAt: updatedAt,
      updatedAt,
    });

    await this.saveState();
  }

  public async recordFailure(
    tokenId: string,
    input: {
      reason: string;
      message: string;
      now?: Date;
    },
  ): Promise<void> {
    const now = input.now ?? new Date();
    const current = this.resolveEffectiveState(tokenId, now);
    const updatedAt = now.toISOString();

    this.stateByTokenId.set(tokenId, {
      usageDayKey: current.usageDayKey,
      usageCount: current.usageCount,
      cooldownUntil: new Date(now.getTime() + this.errorCooldownMs).toISOString(),
      lastFailureReason: input.reason,
      lastFailureMessage: input.message,
      lastSelectedAt: updatedAt,
      updatedAt,
    });

    await this.saveState();
  }

  private loadState(): Map<string, DdgAliasKeyRuntimeState> {
    if (!this.stateFilePath || existsSync(this.stateFilePath) === false) {
      return new Map();
    }

    try {
      const text = readFileSync(this.stateFilePath, { encoding: "utf-8" });
      return parseStateDocument(text ? JSON.parse(text) : undefined);
    } catch {
      return new Map();
    }
  }

  private resolveEffectiveState(tokenId: string, now: Date): DdgAliasKeyEffectiveState {
    const stored = this.stateByTokenId.get(tokenId);
    const nowEpochMs = now.getTime();
    const usageDayKey = toLocalDayKey(now);
    const cooldownUntilEpochMs = stored?.cooldownUntil ? Date.parse(stored.cooldownUntil) : Number.NaN;
    const cooldownActive = Number.isFinite(cooldownUntilEpochMs) && cooldownUntilEpochMs > nowEpochMs;
    const normalizedUsageCount = stored?.usageDayKey === usageDayKey
      ? Math.max(0, stored.usageCount ?? 0)
      : 0;
    const quotaReached = normalizedUsageCount >= this.dailyLimit;

    return {
      usageDayKey,
      usageCount: normalizedUsageCount,
      cooldownUntil: quotaReached
        ? getNextLocalDayStart(now).toISOString()
        : (cooldownActive ? stored?.cooldownUntil : undefined),
      lastFailureReason: stored?.lastFailureReason,
      lastFailureMessage: stored?.lastFailureMessage,
      lastSelectedAt: stored?.lastSelectedAt,
      updatedAt: stored?.updatedAt,
      cooldownActive: quotaReached ? false : cooldownActive,
      quotaReached,
    };
  }

  private async saveState(): Promise<void> {
    if (!this.stateFilePath) {
      return;
    }

    ensureParentDirectory(this.stateFilePath);
    const temporaryPath = `${this.stateFilePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(toStateDocument(this.stateByTokenId)), { encoding: "utf-8" });
    await rename(temporaryPath, this.stateFilePath);
  }
}

export function createDdgAliasKeyPool(options: DdgAliasKeyPoolOptions = {}): DdgAliasKeyPool {
  return new DdgAliasKeyPool(options);
}
