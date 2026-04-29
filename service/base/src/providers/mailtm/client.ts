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

export interface MailTmConfig {
  apiBase: string;
  preferredDomain?: string;
  timeoutSeconds: number;
}

export interface MailTmMailboxCredentials {
  email: string;
  token: string;
  password: string;
}

interface MailTmDomainItem {
  domain?: string;
  isActive?: boolean;
  isPrivate?: boolean;
}

interface MailTmMessageSummary {
  id?: string;
  "@id"?: string;
  subject?: string;
  intro?: string;
  from?: {
    address?: string;
  } | string;
  createdAt?: string;
}

const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2})/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota)/i;

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function resolveSender(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (value && typeof value === "object" && Array.isArray(value) === false) {
    const address = (value as { address?: unknown }).address;
    return typeof address === "string" && address.trim() ? address.trim() : undefined;
  }

  return undefined;
}

function normalizeSender(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const normalizedFilter = normalizeFilter(fromContains);
  if (!normalizedFilter) {
    return true;
  }
  const normalizedSender = normalizeSender(sender);
  if (!normalizedSender) {
    return false;
  }
  return normalizedSender.includes(normalizedFilter);
}

function extractOtp(values: { subject?: unknown; textBody?: unknown; htmlBody?: unknown }) {
  return extractOtpFromContent({
    subject: typeof values.subject === "string" ? values.subject : undefined,
    textBody: typeof values.textBody === "string" ? values.textBody : undefined,
    htmlBody: typeof values.htmlBody === "string" ? values.htmlBody : undefined,
  });
}

function createRandomSuffix(length: number): string {
  let output = "";
  while (output.length < length) {
    output += Math.random().toString(36).slice(2);
  }
  return output.slice(0, length);
}

function classifyMailTmError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

function formatMailTmError(phase: string, status: number): Error {
  const rawMessage = `Mail.tm ${phase} failed with status ${status}.`;
  const category = classifyMailTmError(rawMessage);
  if (category === "capacity") {
    return new Error(`MAILTM_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`MAILTM_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`MAILTM_PROVIDER_FAILURE: ${rawMessage}`);
}

async function requestJson(
  config: MailTmConfig,
  method: string,
  path: string,
  options: {
    token?: string;
    jsonBody?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${config.apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : {},
  };
}

export function resolveMailTmConfig(instance: ProviderInstance): MailTmConfig {
  return {
    apiBase: readMetadata(instance, "apiBase") ?? "https://api.mail.tm",
    preferredDomain: readMetadata(instance, "domain"),
    timeoutSeconds: parseOptionalInteger(readMetadata(instance, "timeoutSeconds")) ?? 15,
  };
}

export function encodeMailTmMailboxRef(instanceId: string, mailbox: MailTmMailboxCredentials): string {
  return `mailtm:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeMailTmMailboxRef(mailboxRef: string, expectedInstanceId: string): MailTmMailboxCredentials | undefined {
  const prefix = `mailtm:${expectedInstanceId}:`;
  if (!mailboxRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(mailboxRef.slice(prefix.length))) as Record<string, unknown>;
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    const token = typeof payload.token === "string" ? payload.token.trim() : "";
    const password = typeof payload.password === "string" ? payload.password.trim() : "";
    if (!email || !token || !password || !email.includes("@")) {
      return undefined;
    }

    return { email, token, password };
  } catch {
    return undefined;
  }
}

export class MailTmClient {
  public constructor(private readonly config: MailTmConfig) {}

  public static fromInstance(instance: ProviderInstance): MailTmClient {
    return new MailTmClient(resolveMailTmConfig(instance));
  }

  public async getDomains(): Promise<string[]> {
    const response = await requestJson(this.config, "GET", "/domains");
    if (response.status !== 200) {
      throw new Error(`Mail.tm getDomains failed with status ${response.status}.`);
    }

    const body = response.body;
    const items = Array.isArray(body)
      ? body as MailTmDomainItem[]
      : asRecordList(asRecord(body)["hydra:member"] ?? asRecord(body).items ?? asRecord(body).member);

    const domains: string[] = [];
    for (const item of items) {
      const domain = typeof (item as MailTmDomainItem).domain === "string" ? (item as MailTmDomainItem).domain!.trim() : "";
      const isActive = (item as MailTmDomainItem).isActive ?? true;
      const isPrivate = (item as MailTmDomainItem).isPrivate ?? false;
      if (domain && isActive && !isPrivate) {
        domains.push(domain);
      }
    }

    return domains;
  }

  public async createAccount(email: string, password: string): Promise<void> {
    const response = await requestJson(this.config, "POST", "/accounts", {
      jsonBody: { address: email, password },
    });

    if (response.status !== 200 && response.status !== 201) {
      throw formatMailTmError("createAccount", response.status);
    }
  }

  public async getToken(email: string, password: string): Promise<string> {
    const response = await requestJson(this.config, "POST", "/token", {
      jsonBody: { address: email, password },
    });

    if (response.status !== 200) {
      throw formatMailTmError("getToken", response.status);
    }

    const token = typeof asRecord(response.body).token === "string" ? String(asRecord(response.body).token).trim() : "";
    if (!token) {
      throw new Error("Mail.tm getToken returned an empty token.");
    }

    return token;
  }

  public async createMailbox(options: { suggestedLocalPart?: string; maxRetries?: number } = {}): Promise<MailTmMailboxCredentials> {
    const domains = await this.getDomains();
    if (domains.length === 0) {
      throw new Error("Mail.tm returned no active public domains.");
    }

    const preferred = this.config.preferredDomain && domains.includes(this.config.preferredDomain)
      ? this.config.preferredDomain
      : undefined;
    const maxRetries = options.maxRetries ?? 5;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const suffix = createRandomSuffix(4);
      const localPart = options.suggestedLocalPart
        ? `${options.suggestedLocalPart}-${suffix}`
        : `oc${createRandomSuffix(10)}`;
      const domain = preferred ?? domains[Math.floor(Math.random() * domains.length)]!;
      const email = `${localPart}@${domain}`;
      const password = `${createRandomSuffix(12)}-${createRandomSuffix(8)}`;

      try {
        await this.createAccount(email, password);
        const token = await this.getToken(email, password);
        return { email, token, password };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = classifyMailTmError(message);
        const isRetryableStatus = /status (400|409|422)/i.test(message);
        const shouldRetry = category === "transient" || category === "capacity" || isRetryableStatus;
        if (attempt === maxRetries - 1 || !shouldRetry) {
          throw error;
        }
      }
    }

    throw new Error("Mail.tm createMailbox exhausted retries.");
  }

  public async listMessages(token: string): Promise<MailTmMessageSummary[]> {
    const response = await requestJson(this.config, "GET", "/messages", { token });
    if (response.status !== 200) {
      throw formatMailTmError("listMessages", response.status);
    }

    const body = response.body;
    const items = Array.isArray(body)
      ? body
      : asRecordList(asRecord(body)["hydra:member"] ?? asRecord(body).messages ?? asRecord(body).member);

    return items as MailTmMessageSummary[];
  }

  public async getMessage(token: string, messageId: string): Promise<Record<string, unknown>> {
    const path = messageId.startsWith("/") ? messageId : `/messages/${encodeURIComponent(messageId)}`;
    const response = await requestJson(this.config, "GET", path, { token });
    if (response.status === 429 || response.status >= 500) {
      throw formatMailTmError("getMessage", response.status);
    }
    if (response.status !== 200) {
      return {};
    }

    return asRecord(response.body);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: MailTmMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.listMessages(mailbox.token);

    for (const item of messages) {
      const messageId = String(item.id ?? item["@id"] ?? "").trim();
      if (!messageId) {
        continue;
      }

      const sender = resolveSender(item.from);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const summaryOtp = extractOtp({
        subject: item.subject,
        textBody: item.intro,
      });

      const detail = await this.getMessage(mailbox.token, messageId);
      const detailSender = resolveSender(detail.from) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContains)) {
        continue;
      }
      const detailSubject = typeof detail.subject === "string" ? detail.subject : undefined;
      const textBody = Array.isArray(detail.text)
        ? detail.text.map((value) => String(value)).join("\n")
        : (typeof detail.text === "string" ? detail.text : undefined);
      const htmlBody = Array.isArray(detail.html)
        ? detail.html.map((value) => String(value)).join("\n")
        : (typeof detail.html === "string" ? detail.html : undefined);
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody: textBody ?? detail.intro,
        htmlBody,
      });
      const selectedOtp = detailOtp ?? summaryOtp;
      return {
        id: `mailtm:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: typeof detail.createdAt === "string" ? detail.createdAt : "",
        sender: detailSender,
        subject: detailSubject,
        textBody,
        htmlBody,
        extractedCode: selectedOtp?.code,
        codeSource: selectedOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeMailTmInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = MailTmClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? `Mail.tm returned ${domains.length} active domains.`
        : "Mail.tm returned no active domains.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "mailtm",
        state: domains.length > 0 ? "ok" : "empty-domain-list",
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const classification = classifyMailTmError(detail);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "mailtm",
        errorClass: classification,
      },
    };
  }
}

