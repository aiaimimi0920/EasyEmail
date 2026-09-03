import { isAbsolute, resolve } from "node:path";
import type {
  MailRoutingProfileDescriptor,
  MailRoutingProfileHealthGate,
  MailStrategyModeResolution,
} from "../domain/models.js";
import { normalizeMailProviderTypeKey } from "../domain/models.js";
import {
  normalizeMailBusinessStrategyId,
  parseMailStrategyModeJson,
} from "../domain/strategy-mode.js";
import type { MailPersistenceDriver } from "../persistence/contracts.js";
import type { AliasProviderRuntimeConfig } from "./config-types.js";

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseEmbeddedLines(value: unknown): string | undefined {
  const text = asNonEmptyString(value);
  return text ? text.replace(/\\n/g, "\n") : undefined;
}

export function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  const text = asNonEmptyString(value);
  if (!text) {
    return undefined;
  }

  const items = text.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  return fallback;
}

export function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseBoolean(value, false);
}

export function parsePositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

export function parseOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return parsePositiveInteger(value, 0, label);
}

function parseOptionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return parsed;
}

export function parsePersistenceDriver(value: unknown): MailPersistenceDriver {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized || normalized === "file") {
    return "file";
  }
  if (normalized === "database" || normalized === "db") {
    return "database";
  }
  if (normalized === "sqlite") {
    return "sqlite";
  }

  throw new Error("persistence.driver must be one of: file, sqlite, database.");
}

function resolveDefaultStatePath(stateDir: string, fileName: string): string {
  return resolve(stateDir, fileName);
}

export function resolvePathWithinStateDir(stateDir: string, value: unknown, fallbackName: string): string {
  const configured = asNonEmptyString(value);
  if (!configured) {
    return resolveDefaultStatePath(stateDir, fallbackName);
  }

  return isAbsolute(configured)
    ? configured
    : resolve(stateDir, configured);
}

export function parseStrategyModeJson(raw: unknown): MailStrategyModeResolution | undefined {
  if (typeof raw === "string") {
    return parseMailStrategyModeJson(raw);
  }

  if (raw && typeof raw === "object" && Array.isArray(raw) === false) {
    return parseMailStrategyModeJson(JSON.stringify(raw));
  }

  return undefined;
}

export function parseAliasProviderConfigs(value: unknown, stateDir: string): AliasProviderRuntimeConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const providers: AliasProviderRuntimeConfig[] = [];
  for (const item of value) {
    const record = asObject(item);
    const key = asNonEmptyString(record.key)?.toLowerCase();
    if (!key) {
      continue;
    }

    if (key !== "ddg") {
      throw new Error(`aliasEmail.providers[].key '${key}' is not supported.`);
    }

    providers.push({
      key: "ddg",
      enabled: parseBoolean(record.enabled, true),
      apiBaseUrl: asNonEmptyString(record.apiBaseUrl) ?? "https://quack.duckduckgo.com",
      tokens: parseStringList(record.tokens),
      tokensText: parseEmbeddedLines(record.tokensText),
      tokensFile: asNonEmptyString(record.tokensFile),
      dailyLimit: parsePositiveInteger(record.dailyLimit, 150, "aliasEmail.providers[].dailyLimit"),
      cooldownMs: parsePositiveInteger(record.cooldownMs, 24 * 60 * 60 * 1000, "aliasEmail.providers[].cooldownMs"),
      stateFilePath: resolvePathWithinStateDir(stateDir, record.stateFilePath, "state/ddg-alias-key-pool.json"),
    });
  }

  return providers;
}

function parseRoutingProfileHealthGate(value: unknown): MailRoutingProfileHealthGate | undefined {
  const record = asObject(value);
  const minimumHealthScore = parseOptionalNonNegativeNumber(
    record.minimumHealthScore,
    "strategy.routingProfiles[].healthGate.minimumHealthScore",
  );
  const maxConsecutiveFailures = parseOptionalPositiveInteger(
    record.maxConsecutiveFailures,
    "strategy.routingProfiles[].healthGate.maxConsecutiveFailures",
  );
  const recentFailureWindowMs = parseOptionalPositiveInteger(
    record.recentFailureWindowMs,
    "strategy.routingProfiles[].healthGate.recentFailureWindowMs",
  );
  const recentFailurePenalty = parseOptionalNonNegativeNumber(
    record.recentFailurePenalty,
    "strategy.routingProfiles[].healthGate.recentFailurePenalty",
  );

  if (
    minimumHealthScore === undefined
    && maxConsecutiveFailures === undefined
    && recentFailureWindowMs === undefined
    && recentFailurePenalty === undefined
  ) {
    return undefined;
  }

  return {
    minimumHealthScore,
    maxConsecutiveFailures,
    recentFailureWindowMs,
    recentFailurePenalty,
  };
}

export function parseRoutingProfiles(value: unknown): MailRoutingProfileDescriptor[] {
  let rawProfiles: unknown[] | undefined;
  if (Array.isArray(value)) {
    rawProfiles = value;
  } else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        rawProfiles = parsed;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`strategy.routingProfiles must be a YAML list or JSON array string: ${reason}`);
    }
  }

  if (!rawProfiles) {
    return [];
  }

  const profiles: MailRoutingProfileDescriptor[] = [];
  for (const item of rawProfiles) {
    const record = asObject(item);
    const id = asNonEmptyString(record.id)?.toLowerCase();
    if (!id) {
      continue;
    }

    const providerSelections = (parseStringList(record.providerSelections) ?? [])
      .map((entry) => normalizeMailProviderTypeKey(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

    profiles.push({
      id,
      displayName: asNonEmptyString(record.displayName) ?? id,
      description: asNonEmptyString(record.description) ?? "",
      providerStrategyModeId: normalizeMailBusinessStrategyId(asNonEmptyString(record.providerStrategyModeId)),
      providerSelections: providerSelections.length > 0 ? providerSelections : undefined,
      strategyProfileId: asNonEmptyString(record.strategyProfileId),
      healthGate: parseRoutingProfileHealthGate(record.healthGate),
    });
  }

  return profiles;
}

export function deriveMailSelectionsFromServiceMode(value: string | undefined): string[] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "cloudflare_temp_email") {
    return ["cloudflare_temp_email"];
  }

  if (normalized === "external-api") {
    return ["mailtm", "m2u", "temporam", "mail2925", "guerrillamail", "moemail", "im215", "duckmail", "tempmail-lol", "etempmail", "gptmail"];
  }

  return undefined;
}
