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
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}>;

import type { ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";

export interface EtempmailConfig {
  apiBase: string;
  preferredDomain?: string;
}

export interface EtempmailMailboxCredentials {
  email: string;
  recoverKey: string;
  mailboxId?: string;
  creationTime?: string;
  sessionCookieHeader?: string;
}

export interface EtempmailMailboxOpenState {
  mailbox: EtempmailMailboxCredentials;
  cookieHeader: string;
}

export interface EtempmailDomainOption {
  id: string;
  domain: string;
}

const ETEMPMAIL_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const ETEMPMAIL_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const ETEMPMAIL_SEC_CH_UA = "\"Google Chrome\";v=\"147\", \"Not.A/Brand\";v=\"8\", \"Chromium\";v=\"147\"";
const ETEMPMAIL_MAX_RETRIES = 2;
const ETEMPMAIL_RETRY_BASE_DELAY_MS = 700;
const ETEMPMAIL_DEFAULT_TTL_MS = 20 * 60 * 1000;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2})/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota)/i;

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
    return String(Math.trunc(value));
  }

  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }

  return undefined;
}

export function normalizeEmailAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return undefined;
  }
  return normalized;
}

export function normalizeDomain(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
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
  const normalizedSender = readStringLike(sender)?.toLowerCase();
  if (!normalizedSender) {
    return false;
  }
  return normalizedSender.includes(normalizedFilter);
}

export function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

export function looksLikeSubjectOnlyOtp(code: string | undefined): boolean {
  const normalized = String(code || "").trim().replace(/[-\s]+/g, "");
  if (!normalized) {
    return false;
  }
  return /\d/.test(normalized);
}

export function classifyEtempmailError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

export function formatEtempmailError(phase: string, status: number, detail?: string): Error {
  const rawMessage = `eTempMail ${phase} failed with status ${status}.${detail ? ` ${detail}` : ""}`;
  const category = classifyEtempmailError(rawMessage);
  if (category === "capacity") {
    return new Error(`ETEMPMAIL_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`ETEMPMAIL_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`ETEMPMAIL_PROVIDER_FAILURE: ${rawMessage}`);
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function parseJsonBody(bodyText: string): unknown {
  if (!bodyText.trim()) {
    return {};
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

export function parseSetCookieHeader(raw: string | null | undefined): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const cookies = raw
    .split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
    .map((entry) => entry.split(";", 1)[0]?.trim() || "")
    .filter(Boolean);

  if (cookies.length <= 0) {
    return undefined;
  }

  return cookies.join("; ");
}

export function normalizeCookieHeader(raw: string | undefined): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const cookieMap = new Map<string, string>();
  for (const part of raw.split(/;\s*/)) {
    const normalized = part.trim();
    if (!normalized) {
      continue;
    }
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = normalized.slice(0, separatorIndex).trim();
    const value = normalized.slice(separatorIndex + 1).trim();
    if (!name || !value) {
      continue;
    }
    cookieMap.set(name, value);
  }

  if (cookieMap.size <= 0) {
    return undefined;
  }

  return Array.from(cookieMap.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function mergeCookieHeaders(
  currentCookieHeader: string | undefined,
  setCookieHeader: string | null | undefined,
): string | undefined {
  const merged = new Map<string, string>();

  for (const source of [
    normalizeCookieHeader(currentCookieHeader),
    parseSetCookieHeader(setCookieHeader),
  ]) {
    if (!source) {
      continue;
    }
    for (const part of source.split(/;\s*/)) {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      merged.set(part.slice(0, separatorIndex), part.slice(separatorIndex + 1));
    }
  }

  if (merged.size <= 0) {
    return undefined;
  }

  return Array.from(merged.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export async function requestRaw(
  config: EtempmailConfig,
  method: string,
  path: string,
  options: {
    cookieHeader?: string;
    body?: string;
    contentType?: string;
    accept?: string;
    xRequestedWith?: boolean;
  } = {},
): Promise<{ status: number; bodyText: string; setCookie?: string }> {
  const normalizedBase = trimTrailingSlash(config.apiBase);
  const origin = normalizedBase;
  const normalizedCookieHeader = normalizeCookieHeader(options.cookieHeader);

  for (let attempt = 0; attempt <= ETEMPMAIL_MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${normalizedBase}${path}`, {
      method,
      headers: {
        Accept: options.accept ?? "*/*",
        "User-Agent": ETEMPMAIL_USER_AGENT,
        "Accept-Language": ETEMPMAIL_ACCEPT_LANGUAGE,
        Referer: `${origin}/`,
        Origin: origin,
        "Sec-CH-UA": ETEMPMAIL_SEC_CH_UA,
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": "\"Windows\"",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        ...(options.contentType ? { "Content-Type": options.contentType } : {}),
        ...(normalizedCookieHeader ? { Cookie: normalizedCookieHeader } : {}),
        ...(options.xRequestedWith ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      },
      body: options.body,
    });

    const bodyText = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < ETEMPMAIL_MAX_RETRIES) {
      await sleep(ETEMPMAIL_RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }

    return {
      status: response.status,
      bodyText,
      setCookie: response.headers.get("set-cookie") ?? undefined,
    };
  }

  return {
    status: 599,
    bodyText: "",
  };
}

export function extractMailbox(body: unknown): EtempmailMailboxCredentials | undefined {
  const record = asRecord(body);
  const email = normalizeEmailAddress(
    readStringLike(record.address)
    ?? readStringLike(record.email)
    ?? readStringLike(record.mail),
  );
  const recoverKey = readStringLike(record.recover_key)
    ?? readStringLike(record.recoverKey)
    ?? readStringLike(record.key);
  const mailboxId = readStringLike(record.id) ?? readStringLike(record.mailboxId);
  const creationTime = readStringLike(record.creation_time)
    ?? readStringLike(record.creationTime)
    ?? readStringLike(record.created_at)
    ?? readStringLike(record.createdAt);

  if (!email || !recoverKey) {
    return undefined;
  }

  return {
    email,
    recoverKey,
    mailboxId,
    creationTime,
    sessionCookieHeader: normalizeCookieHeader(
      readStringLike(record.sessionCookieHeader) ?? readStringLike(record.cookieHeader),
    ),
  };
}

export function extractInboxRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return asRecordList(body);
  }

  const record = asRecord(body);
  const roots = [
    record,
    asRecord(record.data),
    asRecord(record.result),
  ];

  for (const root of roots) {
    const rows = asRecordList(root.messages ?? root.items ?? root.list ?? root.inbox);
    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
}

export function extractDomainOptions(html: string): EtempmailDomainOption[] {
  const options: EtempmailDomainOption[] = [];
  const matches = html.matchAll(/<option value="([^"]*)"(?:[^>]*)>([^<]+)<\/option>/gi);
  for (const match of matches) {
    const id = String(match[1] || "").trim();
    const domain = normalizeDomain(String(match[2] || "").trim());
    if (!id || !domain || domain.startsWith("click here")) {
      continue;
    }
    options.push({ id, domain });
  }
  return options;
}

export function htmlToText(value: string | undefined): string {
  if (!value?.trim()) {
    return "";
  }

  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractHtmlBodyFromDetailPage(html: string): { textBody: string; htmlBody: string } {
  const iframeMatch = html.match(/<iframe[^>]+src=(['"])(data:text\/html,[\s\S]*?)\1/i);
  if (!iframeMatch) {
    return { textBody: "", htmlBody: "" };
  }

  let htmlBody = iframeMatch[2].replace(/^data:text\/html,/i, "");
  try {
    htmlBody = decodeURIComponent(htmlBody);
  } catch {
    htmlBody = iframeMatch[1];
  }

  return {
    textBody: htmlToText(htmlBody),
    htmlBody: htmlBody.trim(),
  };
}

export function parseLooseEtempmailTimestamp(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }

  const slashMatch = text.match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (slashMatch) {
    const [, dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw, secondRaw] = slashMatch;
    const day = Number.parseInt(dayRaw, 10);
    const month = Number.parseInt(monthRaw, 10);
    const year = Number.parseInt(yearRaw, 10);
    const hour = Number.parseInt(hourRaw, 10);
    const minute = Number.parseInt(minuteRaw, 10);
    const second = Number.parseInt(secondRaw ?? "0", 10);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
  }

  const dottedMatch = text.match(
    /^(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*\([^)]+\))?$/i,
  );
  if (dottedMatch) {
    const [, dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw, secondRaw, meridiemRaw] = dottedMatch;
    const day = Number.parseInt(dayRaw, 10);
    const month = Number.parseInt(monthRaw, 10);
    const year = Number.parseInt(yearRaw, 10);
    let hour = Number.parseInt(hourRaw, 10);
    const minute = Number.parseInt(minuteRaw, 10);
    const second = Number.parseInt(secondRaw ?? "0", 10);
    const meridiem = (meridiemRaw || "").trim().toUpperCase();
    if (meridiem === "PM" && hour < 12) {
      hour += 12;
    } else if (meridiem === "AM" && hour === 12) {
      hour = 0;
    }
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
  }

  return undefined;
}

export function toObservedAt(value: unknown): string {
  const raw = readStringLike(value);
  if (!raw) {
    return new Date().toISOString();
  }

  const normalized = parseLooseEtempmailTimestamp(raw);
  if (normalized) {
    return normalized;
  }

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  return raw;
}
