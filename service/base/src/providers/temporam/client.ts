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

import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";

export interface TemporamConfig {
  baseUrl: string;
  userAgent: string;
  acceptLanguage: string;
  acceptEncoding: string;
  preferredDomain?: string;
}

export interface TemporamMailboxCredentials {
  email: string;
  localPart: string;
  domain: string;
  openedAt: string;
}

const TEMPORAM_DEFAULT_BASE_URL = "https://www.temporam.com";
const TEMPORAM_DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const TEMPORAM_DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
const TEMPORAM_DEFAULT_ACCEPT_ENCODING = "identity";
const TEMPORAM_LOCAL_PART_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2}|temporarily unavailable|gateway)/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|capacity)/i;

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
    : [];
}

function readStringLike(value: unknown): string | undefined {
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

function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeDomain(value: string | undefined): string | undefined {
  const normalized = normalizeFilter(value);
  if (!normalized || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeLocalPart(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized || undefined;
}

function createRandomLocalPart(length = 8): string {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += TEMPORAM_LOCAL_PART_ALPHABET[Math.floor(Math.random() * TEMPORAM_LOCAL_PART_ALPHABET.length)] ?? "a";
  }
  return output;
}

function domainMatchesPreference(domain: string | undefined, preferredDomain: string | undefined): boolean {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPreferredDomain = normalizeDomain(preferredDomain);
  if (!normalizedDomain || !normalizedPreferredDomain) {
    return false;
  }
  return normalizedDomain === normalizedPreferredDomain
    || normalizedDomain.endsWith(`.${normalizedPreferredDomain}`);
}

function selectDomain(domains: string[], preferredDomain: string | undefined): string {
  const normalizedPreferredDomain = normalizeDomain(preferredDomain);
  if (normalizedPreferredDomain) {
    const preferredMatches = domains.filter((domain) => domainMatchesPreference(domain, normalizedPreferredDomain));
    if (preferredMatches.length === 0) {
      throw new Error(`TEMPORAM_PROVIDER_FAILURE: Temporam has no available domains matching "${normalizedPreferredDomain}".`);
    }
    return preferredMatches[Math.floor(Math.random() * preferredMatches.length)] ?? preferredMatches[0]!;
  }

  if (domains.length === 0) {
    throw new Error("TEMPORAM_PROVIDER_FAILURE: Temporam returned no available domains.");
  }
  return domains[Math.floor(Math.random() * domains.length)] ?? domains[0]!;
}

function encodeQuery(params: Array<[string, string | number | undefined]>): string {
  const entries = params
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function parseTimestampMs(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function computeSinceIso(openedAt: string | undefined): string {
  const openedAtMs = parseTimestampMs(openedAt);
  const baseMs = openedAtMs ?? Date.now();
  return new Date(baseMs - 10 * 60 * 1000).toISOString();
}

function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
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

function stripHtmlLikeMarkup(value: string | undefined): string | undefined {
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

function hydrateBodies(row: Record<string, unknown>): { textBody?: string; htmlBody?: string } {
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

function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

function readTemporamError(body: unknown): string | undefined {
  const record = asRecord(body);
  return readStringLike(record.message ?? record.error ?? record.reason);
}

function bodyHasTemporamError(body: unknown): boolean {
  const record = asRecord(body);
  if (record.error === true) {
    return true;
  }
  const code = typeof record.code === "number" ? record.code : Number.parseInt(readStringLike(record.code) ?? "", 10);
  return Number.isFinite(code) && code >= 400;
}

function classifyTemporamError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

function formatTemporamError(phase: string, status: number, body: unknown): Error {
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

function buildRequestHeaders(config: TemporamConfig, hasBody: boolean): Record<string, string> {
  const normalizedBase = config.baseUrl.replace(/\/$/, "");
  return {
    Accept: "application/json",
    "User-Agent": config.userAgent,
    "Accept-Language": config.acceptLanguage,
    "Accept-Encoding": config.acceptEncoding,
    Referer: `${normalizedBase}/`,
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

async function requestJson(
  config: TemporamConfig,
  method: string,
  path: string,
  options: { jsonBody?: Record<string, unknown> } = {},
): Promise<{ status: number; body: unknown }> {
  const normalizedBase = config.baseUrl.replace(/\/$/, "");
  const response = await fetch(`${normalizedBase}${path}`, {
    method,
    headers: buildRequestHeaders(config, Boolean(options.jsonBody)),
    body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
  });

  const text = await response.text();
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

function normalizeMessageRow(row: Record<string, unknown>, fallbackId: string): {
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

function sortMessagesNewestFirst(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) => {
    const leftTime = parseTimestampMs(readStringLike(left.createdAt ?? left.created_at ?? left.receivedAt ?? left.received_at ?? left.date)) ?? 0;
    const rightTime = parseTimestampMs(readStringLike(right.createdAt ?? right.created_at ?? right.receivedAt ?? right.received_at ?? right.date)) ?? 0;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return 0;
  });
}

export function resolveTemporamConfig(instance: ProviderInstance): TemporamConfig {
  return {
    baseUrl: readMetadata(instance, "apiBase") ?? readMetadata(instance, "baseUrl") ?? TEMPORAM_DEFAULT_BASE_URL,
    userAgent: readMetadata(instance, "userAgent") ?? TEMPORAM_DEFAULT_USER_AGENT,
    acceptLanguage: readMetadata(instance, "acceptLanguage") ?? TEMPORAM_DEFAULT_ACCEPT_LANGUAGE,
    acceptEncoding: readMetadata(instance, "acceptEncoding") ?? TEMPORAM_DEFAULT_ACCEPT_ENCODING,
    preferredDomain: readMetadata(instance, "preferredDomain"),
  };
}

export function encodeTemporamMailboxRef(instanceId: string, mailbox: TemporamMailboxCredentials): string {
  return `temporam:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeTemporamMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): TemporamMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `temporam:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email)?.toLowerCase();
    const localPart = normalizeLocalPart(readStringLike(payload.localPart ?? payload.local_part));
    const domain = normalizeDomain(readStringLike(payload.domain));
    const openedAt = readStringLike(payload.openedAt ?? payload.opened_at);
    if (!email || !email.includes("@") || !localPart || !domain || !openedAt) {
      return undefined;
    }

    const normalizedEmail = `${localPart}@${domain}`;
    if (email !== normalizedEmail) {
      return undefined;
    }

    return {
      email: normalizedEmail,
      localPart,
      domain,
      openedAt,
    };
  } catch {
    return undefined;
  }
}

export class TemporamClient {
  public constructor(private readonly config: TemporamConfig) {}

  public static fromInstance(instance: ProviderInstance): TemporamClient {
    return new TemporamClient(resolveTemporamConfig(instance));
  }

  public async getDomains(): Promise<string[]> {
    const response = await requestJson(this.config, "GET", "/api/domains");
    if (response.status !== 200 || bodyHasTemporamError(response.body)) {
      throw formatTemporamError("getDomains", response.status, response.body);
    }

    const data = Array.isArray(asRecord(response.body).data)
      ? asRecord(response.body).data as unknown[]
      : [];
    return [...new Set(data
      .map((item) => typeof item === "string" ? item : readStringLike(asRecord(item).domain))
      .map((item) => normalizeDomain(item))
      .filter((item): item is string => Boolean(item)))];
  }

  public async createMailbox(options: {
    preferredDomain?: string;
    requestedLocalPart?: string;
  } = {}): Promise<TemporamMailboxCredentials> {
    const domains = await this.getDomains();
    const domain = selectDomain(domains, options.preferredDomain ?? this.config.preferredDomain);
    const localPart = normalizeLocalPart(options.requestedLocalPart) ?? createRandomLocalPart(8);
    return {
      email: `${localPart}@${domain}`,
      localPart,
      domain,
      openedAt: new Date().toISOString(),
    };
  }

  public async listMessages(
    email: string,
    since: string,
    limit = 50,
  ): Promise<Record<string, unknown>[]> {
    const normalizedEmail = readStringLike(email)?.toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      return [];
    }

    const query = encodeQuery([
      ["email", normalizedEmail],
      ["since", since],
      ["limit", limit],
    ]);
    const response = await requestJson(this.config, "GET", `/api/emails${query}`);
    if (response.status !== 200 || bodyHasTemporamError(response.body)) {
      throw formatTemporamError("listMessages", response.status, response.body);
    }

    return asRecordList(asRecord(response.body).data);
  }

  public async getMessage(messageId: string): Promise<Record<string, unknown>> {
    const normalizedMessageId = readStringLike(messageId);
    if (!normalizedMessageId) {
      return {};
    }

    const response = await requestJson(this.config, "GET", `/api/emails/${encodeURIComponent(normalizedMessageId)}`);
    if (response.status === 404) {
      return {};
    }
    if (response.status !== 200 || bodyHasTemporamError(response.body)) {
      throw formatTemporamError("getMessage", response.status, response.body);
    }

    return asRecord(asRecord(response.body).data);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: TemporamMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = sortMessagesNewestFirst(
      await this.listMessages(mailbox.email, computeSinceIso(mailbox.openedAt), 50),
    );

    for (const row of messages) {
      const summary = normalizeMessageRow(row, sessionId);
      if (!matchesSenderFilter(summary.sender, fromContains)) {
        continue;
      }

      const summaryOtp = extractOtp({ subject: summary.subject, textBody: summary.textBody, htmlBody: summary.htmlBody });
      if (summaryOtp) {
        return {
          id: `temporam:${summary.id}`,
          sessionId,
          providerInstanceId,
          observedAt: summary.observedAt,
          sender: summary.sender,
          subject: summary.subject,
          textBody: summary.textBody,
          htmlBody: summary.htmlBody,
          extractedCode: summaryOtp.code,
          extractedCandidates: summaryOtp.candidates,
          codeSource: summaryOtp.source,
        };
      }

      const detailRow = await this.getMessage(summary.id);
      const detail = normalizeMessageRow({ ...row, ...detailRow }, summary.id);
      if (!matchesSenderFilter(detail.sender, fromContains)) {
        continue;
      }

      const detailOtp = extractOtp({
        subject: detail.subject,
        textBody: detail.textBody,
        htmlBody: detail.htmlBody,
      });

      return {
        id: `temporam:${detail.id}`,
        sessionId,
        providerInstanceId,
        observedAt: detail.observedAt,
        sender: detail.sender,
        subject: detail.subject,
        textBody: detail.textBody,
        htmlBody: detail.htmlBody,
        extractedCode: detailOtp?.code,
        extractedCandidates: detailOtp?.candidates,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeTemporamInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = TemporamClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? `Temporam returned ${domains.length} available domain${domains.length === 1 ? "" : "s"}.`
        : "Temporam returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "temporam",
        state: domains.length > 0 ? "ok" : "empty-domain-list",
        ...(domains.length > 0 ? { domainsCsv: domains.join(",") } : {}),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "temporam",
        errorClass: classifyTemporamError(detail),
      },
    };
  }
}
