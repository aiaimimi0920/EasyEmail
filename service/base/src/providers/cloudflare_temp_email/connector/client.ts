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

import { extractOtpFromContent } from "../../../domain/otp.js";
import type { ObservedMessage, ProviderInstance } from "../../../domain/models.js";

export interface CloudflareTempEmailConfig {
  baseUrl: string;
  customAuth?: string;
  adminAuth?: string;
  domain?: string;
  domains: string[];
  randomSubdomainDomains: string[];
  timeoutSeconds: number;
}

export interface CloudflareTempMailboxCredentials {
  address: string;
  jwt: string;
}

export interface CloudflareTempEmailSendResult {
  deliveryMode: "mailbox_token" | "admin_delegate";
  detail?: string;
}

interface MailCreateAddressResponse {
  address?: string;
  jwt?: string;
}

interface MailCreateMailItem {
  id?: number;
  source?: string;
  from?: string;
  subject?: string;
  raw?: string;
}

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

function normalizeDomainArray(input: unknown): string[] {
  const domains = new Set<string>();
  if (!Array.isArray(input)) {
    return [];
  }

  for (const item of input) {
    const domain = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (domain) {
      domains.add(domain);
    }
  }

  return [...domains];
}

function parseDomainListFromMetadata(
  instance: ProviderInstance,
  options: {
    jsonKey: string;
    listKey: string;
    singularKey?: string;
  },
): string[] {
  const domains = new Set<string>();
  const rawDomainsJson = readMetadata(instance, options.jsonKey);
  if (rawDomainsJson) {
    try {
      for (const item of normalizeDomainArray(JSON.parse(rawDomainsJson) as unknown)) {
        domains.add(item);
      }
    } catch {
      // Ignore malformed stored domain metadata and fall back to list/singular values.
    }
  }

  const rawList = readMetadata(instance, options.listKey);
  if (rawList) {
    for (const item of rawList.split(/[,\r\n;]+/)) {
      const domain = item.trim().toLowerCase();
      if (domain) {
        domains.add(domain);
      }
    }
  }

  const singular = options.singularKey ? readMetadata(instance, options.singularKey) : undefined;
  if (singular?.trim()) {
    domains.add(singular.trim().toLowerCase());
  }

  return [...domains];
}

function parseDomainList(instance: ProviderInstance): string[] {
  return parseDomainListFromMetadata(instance, {
    jsonKey: "domainsJson",
    listKey: "domains",
    singularKey: "domain",
  });
}

function parseRandomSubdomainDomainList(instance: ProviderInstance): string[] {
  return parseDomainListFromMetadata(instance, {
    jsonKey: "randomSubdomainDomainsJson",
    listKey: "randomSubdomainDomains",
  });
}

function parseDomainWeights(instance: ProviderInstance): Record<string, number> {
  const raw = readMetadata(instance, "registrationStatsJson");
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const domains = parsed.domains;
    if (!domains || typeof domains !== "object" || Array.isArray(domains)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(domains as Record<string, unknown>).map(([key, value]) => {
        const record = value && typeof value === "object" && Array.isArray(value) === false
          ? value as Record<string, unknown>
          : {};
        const successCount = Math.max(0, Number.parseInt(String(record.successCount ?? "0"), 10) || 0);
        const failureCount = Math.max(0, Number.parseInt(String(record.failureCount ?? "0"), 10) || 0);
        const weight = (successCount + 1) / (successCount + failureCount + 2);
        return [key.trim().toLowerCase(), weight];
      }),
    );
  } catch {
    return {};
  }
}

function pickWeightedDomain(domains: string[], weights: Record<string, number>): string | undefined {
  if (domains.length === 0) {
    return undefined;
  }

  const normalized = domains.map((domain) => ({
    domain,
    weight: Math.max(0.05, weights[domain] ?? 0.5),
  }));
  const totalWeight = normalized.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return normalized[0]?.domain;
  }

  let cursor = Math.random() * totalWeight;
  for (const item of normalized) {
    cursor -= item.weight;
    if (cursor <= 0) {
      return item.domain;
    }
  }

  return normalized[normalized.length - 1]?.domain;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

function asMailItems(value: unknown): MailCreateMailItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => item && typeof item === "object") as MailCreateMailItem[];
}

function parseRawMailHeader(raw: string | undefined, headerName: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  const escapedHeaderName = headerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escapedHeaderName}:\\s*(.+)$`, "gim");
  const match = regex.exec(raw);
  return match?.[1]?.trim() || undefined;
}

function extractObservedAtFromRaw(raw: string | undefined): string {
  const dateHeader = parseRawMailHeader(raw, "Date");
  if (!dateHeader) {
    return "";
  }

  const parsed = Date.parse(dateHeader);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

async function requestJson(
  config: CloudflareTempEmailConfig,
  method: string,
  path: string,
  options: {
    bearerToken?: string;
    jsonBody?: Record<string, unknown>;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ status: number; body: unknown; rawText: string }> {
  const separator = path.includes("?") ? "&" : "?";
  const withQuery = typeof options.limit === "number"
    ? `${path}${separator}limit=${encodeURIComponent(String(options.limit))}&offset=${encodeURIComponent(String(options.offset ?? 0))}`
    : path;
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, config.timeoutSeconds * 1000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (fetch as unknown as (
      input: string,
      init?: Record<string, unknown>,
    ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>)(
      `${config.baseUrl.replace(/\/$/, "")}${withQuery}`,
      {
        method,
        headers: {
          Accept: "application/json, text/plain, */*",
          ...(config.customAuth ? { "x-custom-auth": config.customAuth } : {}),
          ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
          ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
        },
        body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
        signal: controller.signal,
      },
    );

    const text = await response.text();
    const trimmed = text.trim();
    const parsedBody = (() => {
      if (!trimmed) {
        return {};
      }

      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return trimmed;
      }

      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return trimmed;
      }
    })();

    return {
      status: response.status,
      body: parsedBody,
      rawText: text,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Cloudflare Temp Email request timed out after ${config.timeoutSeconds}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractErrorDetail(body: unknown, rawText?: string): string | undefined {
  if (typeof body === "string") {
    return body.trim() || undefined;
  }

  const record = asRecord(body);
  for (const key of ["error", "message", "detail", "msg"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return rawText?.trim() || undefined;
}

export function resolveCloudflareTempEmailConfig(instance: ProviderInstance): CloudflareTempEmailConfig | undefined {
  const metadataBaseUrl = readMetadata(instance, "baseUrl");
  const connectionBaseUrl = instance.connectionRef.startsWith("http://") || instance.connectionRef.startsWith("https://")
    ? instance.connectionRef
    : undefined;
  const baseUrl = metadataBaseUrl ?? connectionBaseUrl;
  if (!baseUrl) {
    return undefined;
  }

  return {
    baseUrl,
    customAuth: readMetadata(instance, "customAuth"),
    adminAuth: readMetadata(instance, "adminAuth"),
    domain: readMetadata(instance, "domain"),
    domains: parseDomainList(instance),
    randomSubdomainDomains: parseRandomSubdomainDomainList(instance),
    timeoutSeconds: parseOptionalInteger(readMetadata(instance, "timeoutSeconds")) ?? 30,
  };
}

export function encodeCloudflareTempMailboxRef(instanceId: string, mailbox: CloudflareTempMailboxCredentials): string {
  return `cloudflare_temp_email:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeCloudflareTempMailboxRef(mailboxRef: string, expectedInstanceId: string): CloudflareTempMailboxCredentials | undefined {
  const prefix = `cloudflare_temp_email:${expectedInstanceId}:`;
  if (!mailboxRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(mailboxRef.slice(prefix.length))) as Record<string, unknown>;
    const address = typeof payload.address === "string" ? payload.address.trim() : "";
    const jwt = typeof payload.jwt === "string" ? payload.jwt.trim() : "";
    if (!address || !jwt) {
      return undefined;
    }

    return { address, jwt };
  } catch {
    return undefined;
  }
}

export class CloudflareTempEmailCreateClient {
  public constructor(
    private readonly config: CloudflareTempEmailConfig,
    private readonly domainWeights: Record<string, number> = {},
  ) {}

  public static fromInstance(instance: ProviderInstance): CloudflareTempEmailCreateClient | undefined {
    const config = resolveCloudflareTempEmailConfig(instance);
    return config ? new CloudflareTempEmailCreateClient(config, parseDomainWeights(instance)) : undefined;
  }

  private selectDomain(requestedDomain?: string, requestRandomSubdomain = false): string | undefined {
    const forced = requestedDomain?.trim().toLowerCase();
    if (forced) {
      return forced;
    }

    const configuredDomains = requestRandomSubdomain && this.config.randomSubdomainDomains.length > 0
      ? this.config.randomSubdomainDomains
      : (this.config.domains.length > 0
        ? this.config.domains
        : (this.config.domain?.trim() ? [this.config.domain.trim().toLowerCase()] : []));
    return pickWeightedDomain(configuredDomains, this.domainWeights);
  }

  public async newAddress(
    name?: string,
    options: {
      requestedDomain?: string;
      requestRandomSubdomain?: boolean;
    } = {},
  ): Promise<CloudflareTempMailboxCredentials> {
    const requestRandomSubdomain = options.requestRandomSubdomain === true;
    const resolvedDomain = this.selectDomain(options.requestedDomain, requestRandomSubdomain);
    const response = await requestJson(this.config, "POST", "/api/new_address", {
      jsonBody: {
        name: name?.trim() || "",
        ...(resolvedDomain ? { domain: resolvedDomain } : {}),
        ...(requestRandomSubdomain ? { enableRandomSubdomain: true } : {}),
      },
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email newAddress failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    const body = asRecord(response.body) as MailCreateAddressResponse;
    const address = typeof body.address === "string" ? body.address.trim() : "";
    const jwt = typeof body.jwt === "string" ? body.jwt.trim() : "";
    if (!address || !jwt) {
      throw new Error("Cloudflare Temp Email newAddress returned an empty address or jwt.");
    }

    return { address, jwt };
  }

  public async listMails(jwt: string, limit = 20, offset = 0): Promise<MailCreateMailItem[]> {
    const response = await requestJson(this.config, "GET", "/api/mails", {
      bearerToken: jwt,
      limit,
      offset,
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email listMails failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    const body = asRecord(response.body);
    return asMailItems(body.results ?? body.emails ?? body.data);
  }

  public async getMail(jwt: string, mailId: number): Promise<Record<string, unknown>> {
    const response = await requestJson(this.config, "GET", `/api/mail/${encodeURIComponent(String(mailId))}`, {
      bearerToken: jwt,
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email getMail failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    return asRecord(response.body);
  }

  public async requestSendMailAccess(jwt: string): Promise<void> {
    const response = await requestJson(this.config, "POST", "/api/request_send_mail_access", {
      bearerToken: jwt,
      jsonBody: {},
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email requestSendMailAccess failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }
  }

  private async sendMailWithMailboxToken(
    mailbox: CloudflareTempMailboxCredentials,
    request: {
      toEmailAddress: string;
      toName?: string;
      subject: string;
      textBody?: string;
      htmlBody?: string;
      fromName?: string;
    },
  ): Promise<void> {
    const response = await requestJson(this.config, "POST", "/api/send_mail", {
      bearerToken: mailbox.jwt,
      jsonBody: {
        from_name: request.fromName?.trim() || "",
        to_mail: request.toEmailAddress,
        to_name: request.toName?.trim() || "",
        subject: request.subject,
        content: request.htmlBody?.trim() ? request.htmlBody : (request.textBody ?? ""),
        is_html: Boolean(request.htmlBody?.trim()),
      },
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email sendMail failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }
  }

  private async sendMailWithAdminDelegate(
    mailbox: CloudflareTempMailboxCredentials,
    request: {
      toEmailAddress: string;
      toName?: string;
      subject: string;
      textBody?: string;
      htmlBody?: string;
      fromName?: string;
    },
  ): Promise<void> {
    if (!this.config.adminAuth?.trim()) {
      throw new Error("Cloudflare Temp Email adminAuth is not configured.");
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, this.config.timeoutSeconds * 1000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (fetch as unknown as (
        input: string,
        init?: Record<string, unknown>,
      ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>)(
        `${this.config.baseUrl.replace(/\/$/, "")}/admin/send_mail`,
        {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            ...(this.config.customAuth ? { "x-custom-auth": this.config.customAuth } : {}),
            "x-admin-auth": this.config.adminAuth,
          },
          body: JSON.stringify({
            from_name: request.fromName?.trim() || "",
            from_mail: mailbox.address,
            to_mail: request.toEmailAddress,
            to_name: request.toName?.trim() || "",
            subject: request.subject,
            content: request.htmlBody?.trim() ? request.htmlBody : (request.textBody ?? ""),
            is_html: Boolean(request.htmlBody?.trim()),
          }),
          signal: controller.signal,
        },
      );
      const text = await response.text();
      if (response.status !== 200) {
        throw new Error(`Cloudflare Temp Email admin sendMail failed with status ${response.status}${text?.trim() ? `: ${text.trim()}` : "."}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Cloudflare Temp Email admin sendMail timed out after ${this.config.timeoutSeconds}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async sendMailboxMessage(
    mailbox: CloudflareTempMailboxCredentials,
    request: {
      toEmailAddress: string;
      toName?: string;
      subject: string;
      textBody?: string;
      htmlBody?: string;
      fromName?: string;
    },
  ): Promise<CloudflareTempEmailSendResult> {
    if (!request.toEmailAddress.trim()) {
      throw new Error("Cloudflare Temp Email sendMailboxMessage requires a recipient email address.");
    }
    if (!request.subject.trim()) {
      throw new Error("Cloudflare Temp Email sendMailboxMessage requires a subject.");
    }
    if (!request.textBody?.trim() && !request.htmlBody?.trim()) {
      throw new Error("Cloudflare Temp Email sendMailboxMessage requires textBody or htmlBody.");
    }

    try {
      await this.requestSendMailAccess(mailbox.jwt);
    } catch {
      // Best-effort only. Some deployments still rely on admin delegation or manual balance wiring.
    }

    try {
      await this.sendMailWithMailboxToken(mailbox, request);
      return { deliveryMode: "mailbox_token" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldFallback = /no balance|failed to send mail|status 400|status 401|status 403/i.test(message);
      if (!shouldFallback || !this.config.adminAuth?.trim()) {
        throw error;
      }
    }

    await this.sendMailWithAdminDelegate(mailbox, request);
    return {
      deliveryMode: "admin_delegate",
      detail: "mailbox_token_fallback_to_admin",
    };
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: CloudflareTempMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const mails = (await this.listMails(mailbox.jwt)).sort((left, right) => {
      const leftId = typeof left.id === "number" ? left.id : 0;
      const rightId = typeof right.id === "number" ? right.id : 0;
      return rightId - leftId;
    });

    for (const mail of mails) {
      const sender = String(mail.source ?? mail.from ?? "").trim();
      if (fromContains && sender.toLowerCase().includes(fromContains.toLowerCase()) === false) {
        continue;
      }

      const subjectCode = extractOtpFromContent({
        sender,
        subject: mail.subject,
      });
      if (subjectCode) {
        const mailId = typeof mail.id === "number" ? mail.id : undefined;
        const detail = mailId ? await this.getMail(mailbox.jwt, mailId) : {};
        const raw = typeof detail.raw === "string" ? detail.raw : undefined;
        return {
          id: `cloudflare_temp_email:${String(mail.id ?? `${sessionId}:subject`)}`,
          sessionId,
          providerInstanceId,
          observedAt: extractObservedAtFromRaw(raw),
          sender,
          subject: mail.subject,
          htmlBody: raw,
          textBody: raw,
          extractedCode: subjectCode.code,
          codeSource: subjectCode.source,
        };
      }

      const mailId = typeof mail.id === "number" ? mail.id : undefined;
      if (!mailId) {
        continue;
      }

      const detail = await this.getMail(mailbox.jwt, mailId);
      const raw = typeof detail.raw === "string" ? detail.raw : undefined;
      const rawCode = extractOtpFromContent({
        sender,
        subject: typeof mail.subject === "string" ? mail.subject : undefined,
        htmlBody: raw,
        textBody: raw,
      });
      if (!rawCode) {
        continue;
      }
      return {
        id: `cloudflare_temp_email:${mailId}`,
        sessionId,
        providerInstanceId,
        observedAt: extractObservedAtFromRaw(raw),
        sender,
        subject: mail.subject,
        htmlBody: raw,
        textBody: raw,
        extractedCode: rawCode.code,
        codeSource: rawCode.source,
      };
    }

    return undefined;
  }
}

export async function probeCloudflareTempEmailInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  settings?: Record<string, unknown>;
  metadata?: Record<string, string>;
}> {
  const config = resolveCloudflareTempEmailConfig(instance);
  if (!config) {
    return {
      ok: false,
      detail: "Cloudflare Temp Email instance is missing baseUrl/connectionRef.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    const healthResponse = await fetch(`${config.baseUrl.replace(/\/$/, "")}/health_check`, {
      method: "GET",
      headers: {
        Accept: "text/plain, application/json, */*",
        ...(config.customAuth ? { "x-custom-auth": config.customAuth } : {}),
      },
    });
    if (healthResponse.status !== 200) {
      return {
        ok: false,
        detail: `Cloudflare Temp Email health_check returned ${healthResponse.status}.`,
        averageLatencyMs: Date.now() - startedAt,
      };
    }

    let settings: Record<string, unknown> | undefined;
    let metadata: Record<string, string> | undefined;
    try {
      const settingsResponse = await requestJson(config, "GET", "/open_api/settings");
      if (settingsResponse.status === 200) {
        settings = asRecord(settingsResponse.body);
        const availableDomains = normalizeDomainArray(settings.domains);
        const randomSubdomainDomains = normalizeDomainArray(settings.randomSubdomainDomains);
        metadata = {
          ...(availableDomains.length > 0
            ? {
                domains: availableDomains.join(","),
                domainsJson: JSON.stringify(availableDomains),
              }
            : {}),
          ...(randomSubdomainDomains.length > 0
            ? {
                randomSubdomainDomains: randomSubdomainDomains.join(","),
                randomSubdomainDomainsJson: JSON.stringify(randomSubdomainDomains),
              }
            : {}),
        };
        if (Object.keys(metadata).length === 0) {
          metadata = undefined;
        }
      }
    } catch {
      settings = undefined;
      metadata = undefined;
    }

    return {
      ok: true,
      detail: "Cloudflare Temp Email runtime responded successfully.",
      averageLatencyMs: Date.now() - startedAt,
      settings,
      metadata,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
    };
  }
}
