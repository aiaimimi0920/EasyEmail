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

export interface M2uConfig {
  apiBase: string;
  userAgent: string;
  acceptLanguage: string;
  preferredDomain?: string;
}

export interface M2uMailboxCredentials {
  email: string;
  token: string;
  viewToken: string;
  mailboxId?: string;
  expiresAt?: string;
}

interface RequestJsonOptions {
  jsonBody?: Record<string, unknown>;
}

const M2U_DEFAULT_API_BASE = "https://api.m2u.io";
const M2U_DEFAULT_USER_AGENT = "EasyEmailM2U/1.0";
const M2U_DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
const M2U_DOMAIN_MATCH_CONFIDENCE_TARGET = 0.97;
const M2U_DOMAIN_MATCH_MAX_ATTEMPTS = 20;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2})/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|daily_limit_exceeded|rate_limited)/i;

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

function domainMatchesPreference(domain: string | undefined, preferredDomain: string | undefined): boolean {
  const normalizedDomain = normalizeFilter(domain);
  const normalizedPreferredDomain = normalizeFilter(preferredDomain);
  if (!normalizedDomain || !normalizedPreferredDomain) {
    return false;
  }

  return normalizedDomain === normalizedPreferredDomain
    || normalizedDomain.endsWith(`.${normalizedPreferredDomain}`);
}

function resolvePreferredDomains(domains: string[], preferredDomain: string | undefined): string[] {
  const normalizedPreferredDomain = normalizeFilter(preferredDomain);
  if (!normalizedPreferredDomain) {
    return [];
  }

  return [...new Set(domains
    .map((domain) => normalizeFilter(domain))
    .filter((domain): domain is string => Boolean(domain))
    .filter((domain) => domainMatchesPreference(domain, normalizedPreferredDomain)))];
}

function computeDomainMatchAttempts(totalDomainCount: number, matchedDomainCount: number): number {
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

function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

function encodeQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function readErrorCode(body: unknown): string | undefined {
  return readStringLike(asRecord(body).error)?.toLowerCase();
}

function readErrorReason(body: unknown): string | undefined {
  return readStringLike(asRecord(body).reason);
}

function classifyM2uError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

function formatM2uError(phase: string, status: number, body: unknown): Error {
  const errorCode = readErrorCode(body);
  const reason = readErrorReason(body);
  const detailParts = [
    errorCode ? `error=${errorCode}` : undefined,
    reason ? `reason=${reason}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const rawMessage = `M2U ${phase} failed with status ${status}${detailParts.length > 0 ? ` (${detailParts.join(", ")})` : ""}.`;
  const category = classifyM2uError(rawMessage);
  if (category === "capacity") {
    return new Error(`M2U_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`M2U_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`M2U_PROVIDER_FAILURE: ${rawMessage}`);
}

async function requestJson(
  config: M2uConfig,
  method: string,
  path: string,
  options: RequestJsonOptions = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${config.apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "User-Agent": config.userAgent,
      "Accept-Language": config.acceptLanguage,
      ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
    },
    body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
  });

  const text = await response.text();
  if (!text) {
    return {
      status: response.status,
      body: {},
    };
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

export function resolveM2uConfig(instance: ProviderInstance): M2uConfig {
  return {
    apiBase: readMetadata(instance, "apiBase") ?? M2U_DEFAULT_API_BASE,
    userAgent: readMetadata(instance, "userAgent") ?? M2U_DEFAULT_USER_AGENT,
    acceptLanguage: readMetadata(instance, "acceptLanguage") ?? M2U_DEFAULT_ACCEPT_LANGUAGE,
    preferredDomain: readMetadata(instance, "preferredDomain"),
  };
}

export function encodeM2uMailboxRef(instanceId: string, mailbox: M2uMailboxCredentials): string {
  return `m2u:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeM2uMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): M2uMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `m2u:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email) ?? "";
    const token = readStringLike(payload.token) ?? "";
    const viewToken = readStringLike(payload.viewToken) ?? readStringLike(payload.view_token) ?? "";
    if (!email || !token || !viewToken || !email.includes("@")) {
      return undefined;
    }

    return {
      email: email.trim().toLowerCase(),
      token: token.trim(),
      viewToken: viewToken.trim(),
      mailboxId: readStringLike(payload.mailboxId ?? payload.mailbox_id ?? payload.id),
      expiresAt: readStringLike(payload.expiresAt ?? payload.expires_at),
    };
  } catch {
    return undefined;
  }
}

export class M2uClient {
  public constructor(private readonly config: M2uConfig) {}

  public static fromInstance(instance: ProviderInstance): M2uClient {
    return new M2uClient(resolveM2uConfig(instance));
  }

  public async getDomains(): Promise<string[]> {
    const response = await requestJson(this.config, "GET", "/v1/domains");
    if (response.status !== 200) {
      throw formatM2uError("getDomains", response.status, response.body);
    }

    const domains = Array.isArray(asRecord(response.body).domains)
      ? asRecord(response.body).domains as unknown[]
      : [];
    return domains
      .map((item) => readStringLike(item))
      .filter((item): item is string => Boolean(item));
  }

  public async createMailbox(options: { token?: string; preferredDomain?: string } = {}): Promise<M2uMailboxCredentials> {
    const preferredDomain = normalizeFilter(options.preferredDomain ?? this.config.preferredDomain);
    let preferredDomains: string[] = [];
    let attempts = 1;

    if (preferredDomain) {
      const domains = await this.getDomains();
      preferredDomains = resolvePreferredDomains(domains, preferredDomain);
      if (preferredDomains.length === 0) {
        throw new Error(`M2U_PROVIDER_FAILURE: M2U has no available domains matching "${preferredDomain}".`);
      }
      attempts = computeDomainMatchAttempts(domains.length, preferredDomains.length);
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const requestedDomain = preferredDomains.length > 0
        ? preferredDomains[attempt % preferredDomains.length]
        : undefined;
      const payload = {
        ...(options.token?.trim() ? { token: options.token.trim() } : {}),
        ...(requestedDomain ? { domain: requestedDomain } : {}),
      };
      const response = await requestJson(this.config, "POST", "/v1/mailboxes/auto", {
        jsonBody: payload,
      });

      if (response.status !== 200 && response.status !== 201) {
        throw formatM2uError("createMailbox", response.status, response.body);
      }

      const mailbox = asRecord(asRecord(response.body).mailbox);
      const localPart = readStringLike(mailbox.local_part);
      const domain = normalizeFilter(readStringLike(mailbox.domain));
      const token = readStringLike(mailbox.token);
      const viewToken = readStringLike(mailbox.view_token);
      if (!localPart || !domain || !token || !viewToken) {
        throw new Error("M2U_PROVIDER_FAILURE: M2U createMailbox returned an incomplete mailbox payload.");
      }

      if (preferredDomain && !domainMatchesPreference(domain, preferredDomain)) {
        continue;
      }

      return {
        email: `${localPart}@${domain}`.toLowerCase(),
        token,
        viewToken,
        mailboxId: readStringLike(mailbox.id),
        expiresAt: readStringLike(mailbox.expires_at),
      };
    }

    throw new Error(`M2U_PROVIDER_FAILURE: M2U could not obtain a mailbox matching "${preferredDomain}" after ${attempts} attempts.`);
  }

  public async listMessages(token: string, viewToken: string): Promise<Record<string, unknown>[]> {
    const response = await requestJson(
      this.config,
      "GET",
      `/v1/mailboxes/${encodeURIComponent(token)}${"/messages"}${encodeQuery({ view: viewToken })}`,
    );
    if (response.status === 429 || response.status >= 500) {
      throw formatM2uError("listMessages", response.status, response.body);
    }
    if (response.status !== 200) {
      return [];
    }

    return asRecordList(asRecord(response.body).messages);
  }

  public async getMessage(token: string, viewToken: string, messageId: string): Promise<Record<string, unknown>> {
    const response = await requestJson(
      this.config,
      "GET",
      `/v1/mailboxes/${encodeURIComponent(token)}/messages/${encodeURIComponent(messageId)}${encodeQuery({ view: viewToken })}`,
    );
    if (response.status === 429 || response.status >= 500) {
      throw formatM2uError("getMessage", response.status, response.body);
    }
    if (response.status !== 200) {
      return {};
    }

    return asRecord(asRecord(response.body).message);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: M2uMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.listMessages(mailbox.token, mailbox.viewToken);

    for (const item of messages) {
      const messageId = readStringLike(item.id) ?? sessionId;
      const sender = readStringLike(item.from_addr ?? item.from);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const subject = readStringLike(item.subject);
      const summaryOtp = extractOtp({ subject });
      if (summaryOtp) {
        return {
          id: `m2u:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: readStringLike(item.received_at) ?? "",
          sender,
          subject,
          extractedCode: summaryOtp.code,
          extractedCandidates: summaryOtp.candidates,
          codeSource: summaryOtp.source,
        };
      }

      const detail = await this.getMessage(mailbox.token, mailbox.viewToken, messageId);
      const detailSender = readStringLike(detail.from_addr ?? detail.from) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContains)) {
        continue;
      }

      const detailSubject = readStringLike(detail.subject) ?? subject;
      const textBody = readStringLike(detail.text_body ?? detail.textBody ?? detail.text);
      const htmlBody = readStringLike(detail.html_body ?? detail.htmlBody ?? detail.html);
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody,
        htmlBody,
      });

      return {
        id: `m2u:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: readStringLike(detail.received_at) ?? readStringLike(item.received_at) ?? "",
        sender: detailSender,
        subject: detailSubject,
        textBody,
        htmlBody,
        extractedCode: detailOtp?.code,
        extractedCandidates: detailOtp?.candidates,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeM2uInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = M2uClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? `M2U returned ${domains.length} domains.`
        : "M2U returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "m2u",
        state: domains.length > 0 ? "ok" : "empty-domain-list",
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const classification = classifyM2uError(detail);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "m2u",
        errorClass: classification,
      },
    };
  }
}
