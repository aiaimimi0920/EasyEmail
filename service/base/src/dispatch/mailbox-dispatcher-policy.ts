import { normalizeMailProviderTypeKey } from "../domain/models.js";
import type { ProviderInstance, VerificationMailboxRequest } from "../domain/models.js";
import { parseTimestampMs } from "../shared/utils.js";

export function parseNonNegativeInteger(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseBooleanMetadata(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function parsePolicyCooldownMs(value: string | undefined, fallbackSeconds: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds;
  return Math.max(0, seconds) * 1000;
}

export function normalizeDomain(value: string | undefined): string | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || undefined;
}

function parseDomainList(value: string | undefined): string[] {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }

  const parsed: string[] = [];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const items = JSON.parse(raw);
      if (Array.isArray(items)) {
        for (const item of items) {
          const domain = normalizeDomain(typeof item === "string" ? item : undefined);
          if (domain) {
            parsed.push(domain);
          }
        }
      }
    } catch {
      // Fall back to plain-text parsing when the metadata is not valid JSON.
    }
  }

  const normalizedRaw = raw.replace(/[;\r\n|]/g, ",");
  for (const item of normalizedRaw.split(",")) {
    const domain = normalizeDomain(item);
    if (domain) {
      parsed.push(domain);
    }
  }

  return [...new Set(parsed)];
}

export function resolveRequestExcludedDomains(request: VerificationMailboxRequest): Set<string> {
  return new Set([
    ...(request.excludedDomains ?? [])
      .map((item) => normalizeDomain(item))
      .filter((item): item is string => item !== undefined),
    ...parseDomainList(request.metadata?.excludedDomains),
    ...parseDomainList(request.metadata?.excludedDomain),
  ]);
}

function resolveSupportedDomains(instance: ProviderInstance): string[] {
  const explicitDomains = [
    ...parseDomainList(instance.metadata.domainsCsv),
    ...parseDomainList(instance.metadata.domains),
    ...parseDomainList(instance.metadata.availableDomains),
    ...parseDomainList(instance.metadata.supportedDomains),
  ];
  if (explicitDomains.length > 0) {
    return [...new Set(explicitDomains)];
  }

  return [...new Set([
    ...parseDomainList(instance.metadata.domain),
    ...parseDomainList(instance.metadata.preferredDomain),
  ])];
}

export function instanceSupportsRequestedDomain(
  instance: ProviderInstance,
  requestedDomain: string | undefined,
): boolean {
  const normalizedRequestedDomain = normalizeDomain(requestedDomain);
  if (!normalizedRequestedDomain) {
    return true;
  }

  const supportedDomains = resolveSupportedDomains(instance);
  if (supportedDomains.length === 0) {
    return true;
  }

  return supportedDomains.includes(normalizedRequestedDomain);
}

export function instanceCanAvoidExcludedDomains(
  instance: ProviderInstance,
  excludedDomains: Set<string>,
): boolean {
  if (excludedDomains.size === 0) {
    return true;
  }
  const supportedDomains = resolveSupportedDomains(instance);
  if (supportedDomains.length === 0) {
    return true;
  }
  return supportedDomains.some((domain) => !excludedDomains.has(domain));
}

export function shouldSkipForStructuredMailboxOutcome(instance: ProviderInstance, nowMs: number): boolean {
  const lastOutcome = instance.metadata.lastRegistrationOutcome?.trim().toLowerCase();
  if (lastOutcome !== "failure") {
    return false;
  }

  const attributionKind = instance.metadata.lastRegistrationAttributionKind?.trim().toLowerCase();
  if (attributionKind !== "provider_route") {
    return false;
  }

  const attributedProviderTypeKey = normalizeMailProviderTypeKey(
    instance.metadata.lastRegistrationAttributionProviderTypeKey,
  );
  if (attributedProviderTypeKey && attributedProviderTypeKey !== instance.providerTypeKey) {
    return false;
  }

  const attributionStrength = instance.metadata.lastRegistrationAttributionStrength?.trim().toLowerCase();
  const globalBlacklist = parseBooleanMetadata(instance.metadata.lastRegistrationPolicyGlobalBlacklist);
  if (globalBlacklist && attributionStrength === "strong") {
    return true;
  }

  if (!parseBooleanMetadata(instance.metadata.lastRegistrationPolicyAvoidInCurrentAttempt)) {
    return false;
  }

  const observedAtMs = parseTimestampMs(instance.metadata.lastRegistrationOutcomeAt);
  if (observedAtMs == null) {
    return false;
  }

  const defaultCooldownSeconds = attributionStrength === "weak" ? 10 * 60 : 5 * 60;
  const cooldownMs = parsePolicyCooldownMs(
    instance.metadata.lastRegistrationPolicyCooldownSeconds,
    defaultCooldownSeconds,
  );
  if (cooldownMs <= 0) {
    return false;
  }

  return Math.max(0, nowMs - observedAtMs) < cooldownMs;
}

export function isMailboxDomainRiskOutcome(instance: ProviderInstance): boolean {
  const lastOutcome = instance.metadata.lastRegistrationOutcome?.trim().toLowerCase();
  if (lastOutcome !== "failure") {
    return false;
  }
  return instance.metadata.lastRegistrationAttributionKind?.trim().toLowerCase() === "mailbox_domain_risk";
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

export function computeRecentMailboxFailurePenalty(instance: ProviderInstance, nowMs: number): number {
  if (isMailboxDomainRiskOutcome(instance)) {
    return 0;
  }

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

export function resolveRequestedDomain(request: VerificationMailboxRequest): string | undefined {
  return request.requestedDomain?.trim().toLowerCase()
    || request.metadata?.requestedDomain?.trim().toLowerCase()
    || request.metadata?.mailcreateDomain?.trim().toLowerCase()
    || undefined;
}
