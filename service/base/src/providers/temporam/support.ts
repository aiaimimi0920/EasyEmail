declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

import type { ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";
import { fetchProviderResource } from "../http-policy.js";
import type { TemporamConfig } from "./client.js";

// Temporam's current authenticated API is served under /v3. Keep the legacy
// www host handling below for installations that still use the old web API.
export const TEMPORAM_DEFAULT_BASE_URL = "https://api.temporam.com/v3";
export const TEMPORAM_DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
export const TEMPORAM_DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
export const TEMPORAM_DEFAULT_ACCEPT_ENCODING = "identity";
const TEMPORAM_LOCAL_PART_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2}|temporarily unavailable|gateway)/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|capacity)/i;
const TEMPORAM_MAX_RETRIES = 2;
const TEMPORAM_RETRY_BASE_DELAY_MS = 700;

export function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
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

export function readStringLike(value: unknown): string | undefined {
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

export function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function normalizeDomain(value: string | undefined): string | undefined {
  const normalized = normalizeFilter(value);
  if (!normalized || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function normalizeLocalPart(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized || undefined;
}

export function createRandomLocalPart(length = 8): string {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += TEMPORAM_LOCAL_PART_ALPHABET[Math.floor(Math.random() * TEMPORAM_LOCAL_PART_ALPHABET.length)] ?? "a";
  }
  return output;
}

export function domainMatchesPreference(domain: string | undefined, preferredDomain: string | undefined): boolean {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPreferredDomain = normalizeDomain(preferredDomain);
  if (!normalizedDomain || !normalizedPreferredDomain) {
    return false;
  }
  return normalizedDomain === normalizedPreferredDomain
    || normalizedDomain.endsWith(`.${normalizedPreferredDomain}`);
}

export function selectDomain(
  domains: string[],
  preferredDomain: string | undefined,
  excludedDomains: string[] = [],
): string {
  const excludedSet = new Set(
    excludedDomains
      .map((domain) => normalizeDomain(domain))
      .filter((domain): domain is string => Boolean(domain)),
  );
  const candidateDomains = domains.filter((domain) => !excludedSet.has(normalizeDomain(domain) ?? ""));
  const normalizedPreferredDomain = normalizeDomain(preferredDomain);
  if (normalizedPreferredDomain) {
    const preferredMatches = candidateDomains.filter((domain) => domainMatchesPreference(domain, normalizedPreferredDomain));
    if (preferredMatches.length === 0) {
      throw new Error(`TEMPORAM_PROVIDER_FAILURE: Temporam has no available domains matching "${normalizedPreferredDomain}".`);
    }
    return preferredMatches[Math.floor(Math.random() * preferredMatches.length)] ?? preferredMatches[0]!;
  }

  if (candidateDomains.length === 0) {
    throw new Error("TEMPORAM_PROVIDER_FAILURE: Temporam returned no available domains after exclusions.");
  }
  return candidateDomains[Math.floor(Math.random() * candidateDomains.length)] ?? candidateDomains[0]!;
}

export function encodeQuery(params: Array<[string, string | number | undefined]>): string {
  const entries = params
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

export function parseTimestampMs(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function computeSinceIso(openedAt: string | undefined): string {
  const openedAtMs = parseTimestampMs(openedAt);
  const baseMs = openedAtMs ?? Date.now();
  return new Date(baseMs - 10 * 60 * 1000).toISOString();
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

export function stripHtmlLikeMarkup(value: string | undefined): string | undefined {
  const normalized = readStringLike(value);
  if (!normalized) {
    return undefined;
  }

  const text = normalized
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

export function hydrateBodies(row: Record<string, unknown>): { textBody?: string; htmlBody?: string } {
  const explicitText = readStringLike(row.textBody ?? row.text_body ?? row.text ?? row.plainText ?? row.plain);
  const explicitHtml = readStringLike(row.htmlBody ?? row.html_body ?? row.html);
  const content = readStringLike(row.content ?? row.body ?? row.message);
  const contentLooksHtml = Boolean(content && /<\/?[a-z][^>]*>/i.test(content));
  const htmlBody = explicitHtml ?? (contentLooksHtml ? content : undefined);
  const textBody = explicitText ?? (contentLooksHtml ? stripHtmlLikeMarkup(content) : content);
  return {
    textBody,
    htmlBody,
  };
}

export function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

export function readTemporamError(body: unknown): string | undefined {
  const record = asRecord(body);
  return readStringLike(record.message ?? record.error ?? record.reason);
}

export function bodyHasTemporamError(body: unknown): boolean {
  const record = asRecord(body);
  if (record.error === true) {
    return true;
  }
  const code = typeof record.code === "number" ? record.code : Number.parseInt(readStringLike(record.code) ?? "", 10);
  return Number.isFinite(code) && code >= 400;
}

export function classifyTemporamError(message: string): "transient" | "capacity" | "provider" | "configuration" {
  if (message.startsWith("TEMPORAM_CONFIGURATION_FAILURE:")) return "configuration";
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

export function formatTemporamError(phase: string, status: number, body: unknown): Error {
  const detail = readTemporamError(body);
  const rawMessage = `Temporam ${phase} failed with status ${status}${detail ? ` (${detail})` : ""}.`;
  const category = classifyTemporamError(rawMessage);
  if (category === "capacity") {
    return new Error(`TEMPORAM_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`TEMPORAM_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`TEMPORAM_PROVIDER_FAILURE: ${rawMessage}`);
}

export function buildRequestHeaders(config: TemporamConfig, hasBody: boolean): Record<string, string> {
  const normalizedBase = config.baseUrl.replace(/\/$/, "");
  return {
    Accept: "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    "User-Agent": config.userAgent,
    "Accept-Language": config.acceptLanguage,
    "Accept-Encoding": config.acceptEncoding,
    Referer: `${normalizedBase}/`,
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

export function isLegacyTemporamBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "www.temporam.com";
  } catch {
    return false;
  }
}

export function endpointPath(config: TemporamConfig, path: string): string {
  return isLegacyTemporamBaseUrl(config.baseUrl) ? `/api${path}` : path;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function requestJson(
  config: TemporamConfig,
  method: string,
  path: string,
  options: { jsonBody?: Record<string, unknown> } = {},
): Promise<{ status: number; body: unknown }> {
  const normalizedBase = config.baseUrl.replace(/\/$/, "");
  const endpoint = URL.parse(normalizedBase);
  if (
    endpoint?.origin === "https://api.temporam.com"
    && endpoint.pathname === "/v3"
    && !config.apiKey?.trim()
  ) {
    throw new Error("TEMPORAM_CONFIGURATION_FAILURE: Temporam API key is required for the official v3 API.");
  }
  for (let attempt = 0; attempt <= TEMPORAM_MAX_RETRIES; attempt += 1) {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchProviderResource(`${normalizedBase}${path}`, {
        method,
        headers: buildRequestHeaders(config, Boolean(options.jsonBody)),
        body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
      });
    } catch (error) {
      // Node's fetch reports transient DNS/TLS/socket failures as a rejected
      // promise (for example, "fetch failed") rather than an HTTP response.
      // Retry those failures before letting the provider circuit breaker cool
      // the only configured mailbox route.
      if (attempt < TEMPORAM_MAX_RETRIES) {
        await sleep(TEMPORAM_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw error;
    }

    const text = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < TEMPORAM_MAX_RETRIES) {
      await sleep(TEMPORAM_RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }

    if (!text) {
      return { status: response.status, body: {} };
    }

    try {
      return {
        status: response.status,
        body: JSON.parse(text),
      };
    } catch {
      return {
        status: response.status,
        body: text,
      };
    }
  }

  return { status: 599, body: {} };
}

export function normalizeMessageRow(row: Record<string, unknown>, fallbackId: string): {
  id: string;
  sender?: string;
  subject?: string;
  observedAt: string;
  textBody?: string;
  htmlBody?: string;
} {
  const id = readStringLike(row.id ?? row.emailId ?? row._id) ?? fallbackId;
  const sender = readStringLike(row.fromEmail ?? row.from_email ?? row.senderEmail ?? row.sender ?? row.from);
  const subject = readStringLike(row.subject ?? row.title);
  const observedAt = readStringLike(row.createdAt ?? row.created_at ?? row.receivedAt ?? row.received_at ?? row.date) ?? "";
  const bodies = hydrateBodies(row);
  return {
    id,
    sender,
    subject,
    observedAt,
    textBody: bodies.textBody,
    htmlBody: bodies.htmlBody,
  };
}

export function sortMessagesNewestFirst(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) => {
    const leftTime = parseTimestampMs(readStringLike(left.createdAt ?? left.created_at ?? left.receivedAt ?? left.received_at ?? left.date)) ?? 0;
    const rightTime = parseTimestampMs(readStringLike(right.createdAt ?? right.created_at ?? right.receivedAt ?? right.received_at ?? right.date)) ?? 0;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return 0;
  });
}
