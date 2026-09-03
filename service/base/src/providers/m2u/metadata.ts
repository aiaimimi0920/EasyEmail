import type { ProviderInstance } from "../../domain/models.js";
import { M2U_DEFAULT_PROBE_MAILBOX_SMOKE_INTERVAL_SECONDS } from "./constants.js";

export function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

export function readStringLike(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }

  return undefined;
}

export function parseBooleanMetadata(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseTimestampMs(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveProbeMailboxSmokeIntervalMs(instance: ProviderInstance): number {
  const fallbackSeconds = parsePositiveInteger(
    process.env.M2U_PROBE_MAILBOX_SMOKE_INTERVAL_SECONDS,
    M2U_DEFAULT_PROBE_MAILBOX_SMOKE_INTERVAL_SECONDS,
  );
  const configuredSeconds = parsePositiveInteger(
    readMetadata(instance, "probeMailboxSmokeIntervalSeconds"),
    fallbackSeconds,
  );
  return Math.max(1, configuredSeconds) * 1000;
}

export function resolveCachedProbeMailboxSmokeResult(
  instance: ProviderInstance,
  nowMs: number,
): {
  ok: boolean;
  detail: string;
  metadata: Record<string, string>;
} | undefined {
  const probeAtMs = parseTimestampMs(readMetadata(instance, "lastProbeCreateMailboxAt"));
  if (probeAtMs === undefined) {
    return undefined;
  }

  if ((nowMs - probeAtMs) > resolveProbeMailboxSmokeIntervalMs(instance)) {
    return undefined;
  }

  const cachedOk = parseBooleanMetadata(readMetadata(instance, "lastProbeCreateMailboxOk"));
  if (cachedOk === undefined) {
    return undefined;
  }

  const lastRegistrationOutcome = readMetadata(instance, "lastRegistrationOutcome")?.toLowerCase();
  const lastRegistrationAttributionKind = readMetadata(instance, "lastRegistrationAttributionKind")?.toLowerCase();
  const lastRegistrationOutcomeAtMs = parseTimestampMs(readMetadata(instance, "lastRegistrationOutcomeAt"));
  if (
    cachedOk
    && lastRegistrationOutcome === "failure"
    && lastRegistrationAttributionKind !== "mailbox_domain_risk"
    && lastRegistrationOutcomeAtMs !== undefined
    && lastRegistrationOutcomeAtMs > probeAtMs
  ) {
    return undefined;
  }

  const detail = readMetadata(instance, "lastProbeCreateMailboxDetail")
    ?? (cachedOk ? "cached_probe_mailbox_smoke_success" : "cached_probe_mailbox_smoke_failure");
  const metadata: Record<string, string> = {
    lastProbeCreateMailboxAt: new Date(probeAtMs).toISOString(),
    lastProbeCreateMailboxOk: cachedOk ? "true" : "false",
    lastProbeCreateMailboxDetail: detail,
  };
  const cachedEmail = readMetadata(instance, "lastProbeCreateMailboxEmail");
  if (cachedEmail) {
    metadata.lastProbeCreateMailboxEmail = cachedEmail;
  }
  return {
    ok: cachedOk,
    detail,
    metadata,
  };
}
