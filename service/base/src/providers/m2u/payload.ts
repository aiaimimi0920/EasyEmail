import { extractOtpFromContent } from "../../domain/otp.js";
import {
  M2U_DOMAIN_MATCH_CONFIDENCE_TARGET,
  M2U_DOMAIN_MATCH_MAX_ATTEMPTS,
} from "./constants.js";
import { readStringLike } from "./metadata.js";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

export function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
    : [];
}

export function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function normalizeLocalPart(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function domainMatchesPreference(domain: string | undefined, preferredDomain: string | undefined): boolean {
  const normalizedDomain = normalizeFilter(domain);
  const normalizedPreferredDomain = normalizeFilter(preferredDomain);
  if (!normalizedDomain || !normalizedPreferredDomain) {
    return false;
  }

  return normalizedDomain === normalizedPreferredDomain
    || normalizedDomain.endsWith(`.${normalizedPreferredDomain}`);
}

export function resolvePreferredDomains(domains: string[], preferredDomain: string | undefined): string[] {
  const normalizedPreferredDomain = normalizeFilter(preferredDomain);
  if (!normalizedPreferredDomain) {
    return [];
  }

  return [...new Set(domains
    .map((domain) => normalizeFilter(domain))
    .filter((domain): domain is string => Boolean(domain))
    .filter((domain) => domainMatchesPreference(domain, normalizedPreferredDomain)))];
}

export function computeDomainMatchAttempts(totalDomainCount: number, matchedDomainCount: number): number {
  if (totalDomainCount <= 0 || matchedDomainCount <= 0 || matchedDomainCount >= totalDomainCount) {
    return 1;
  }

  const failureProbability = 1 - (matchedDomainCount / totalDomainCount);
  if (failureProbability <= 0) {
    return 1;
  }

  const attempts = Math.ceil(
    Math.log(1 - M2U_DOMAIN_MATCH_CONFIDENCE_TARGET) / Math.log(failureProbability),
  );
  return Math.min(M2U_DOMAIN_MATCH_MAX_ATTEMPTS, Math.max(2, attempts));
}

export function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const normalizedFilter = normalizeFilter(fromContains);
  if (!normalizedFilter) {
    return true;
  }

  const normalizedSender = readStringLike(sender)?.toLowerCase();
  if (!normalizedSender) {
    return false;
  }

  return normalizedSender.includes(normalizedFilter);
}

export function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

export function encodeQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}
