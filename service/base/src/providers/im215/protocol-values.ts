import { randomBytes } from "node:crypto";
import type { ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";

const DOMAIN_ROTATION_OFFSETS = new Map<string, number>();

export function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

export function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

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

export function readString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }
  return undefined;
}

export function readSender(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (value && typeof value === "object" && Array.isArray(value) === false) {
    const record = value as Record<string, unknown>;
    return readString(record.address)
      ?? readString(record.email)
      ?? readString(record.name)
      ?? readString(record.username)
      ?? readString(record.mail);
  }
  return undefined;
}

export function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const normalizedFilter = normalizeFilter(fromContains);
  if (!normalizedFilter) {
    return true;
  }
  const normalizedSender = sender?.trim().toLowerCase();
  if (!normalizedSender) {
    return false;
  }
  return normalizedSender.includes(normalizedFilter);
}

export function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

export function encodeQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

export function createRandomSuffix(length: number): string {
  return randomBytes(Math.max(length * 2, 12)).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, length).toLowerCase();
}

export function normalizeDomain(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function isDisabledFlag(value: unknown): boolean {
  return value === false
    || (typeof value === "string" && ["disabled", "inactive", "offline", "false", "unavailable"].includes(value.trim().toLowerCase()));
}

export function isIm215DomainUsable(item: Record<string, unknown>): boolean {
  if (isDisabledFlag(item.active)
    || isDisabledFlag(item.enabled)
    || isDisabledFlag(item.isActive)
    || isDisabledFlag(item.available)
    || isDisabledFlag(item.status)
    || item.isPublic === false
    || item.isVerified === false
    || item.isMxValid === false) {
    return false;
  }

  const dnsRecords = asRecord(item.dnsRecords);
  return dnsRecords.receivingReady !== false && dnsRecords.mxValid !== false;
}

export function nextDomainRotationOffset(namespace: string, domainCount: number): number {
  if (domainCount <= 1) {
    return 0;
  }

  const current = DOMAIN_ROTATION_OFFSETS.get(namespace) ?? 0;
  DOMAIN_ROTATION_OFFSETS.set(namespace, (current + 1) % domainCount);
  return current % domainCount;
}

export function sanitizeLocalPart(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[^a-z]+/, "m");
  const base = normalized || `m${createRandomSuffix(8)}`;
  return base.slice(0, 48);
}
