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

import { randomBytes } from "node:crypto";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";

export interface DuckMailConfig {
  apiBase: string;
  preferredDomain?: string;
  apiKey?: string;
  expiresIn?: number;
  passwordLength: number;
}

export interface DuckMailMailboxCredentials {
  email: string;
  token: string;
  password: string;
  accountId: string;
}

interface RequestJsonOptions {
  token?: string;
  apiKey?: string;
  jsonBody?: Record<string, unknown>;
}


function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function normalizeFromContains(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
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

function readSender(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (value && typeof value === "object" && Array.isArray(value) === false) {
    const sender = value as Record<string, unknown>;
    const name = readStringLike(sender.name);
    const address = readStringLike(sender.address);
    const merged = [name, address].filter(Boolean).join(" ").trim();
    return merged || address || name || undefined;
  }

  return undefined;
}

function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const expected = normalizeFromContains(fromContains);
  if (!expected) {
    return true;
  }
  if (!sender) {
    return false;
  }
  return sender.toLowerCase().includes(expected);
}

function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

function createAlphaNumeric(length: number): string {
  return randomBytes(Math.max(length * 2, 16))
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, length);
}

function createPassword(length: number): string {
  return createAlphaNumeric(Math.max(8, length || 12));
}

function sanitizeLocalPart(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "");
  const withPrefix = /^[a-z]/.test(normalized) ? normalized : `d${normalized}`;
  const base = withPrefix.replace(/^[^a-z]+/, "d");
  return (base || `d${createAlphaNumeric(6).toLowerCase()}`).slice(0, 48);
}

function encodeQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function buildDuckMailStatusError(
  operation: string,
  status: number,
  body: unknown,
): Error {
  const bodyHint = readStringLike(body);
  if (status === 429) {
    return new Error(
      `DUCKMAIL_CAPACITY_FAILURE: ${operation} failed with status 429 (rate limit).${bodyHint ? ` ${bodyHint}` : ""}`,
    );
  }
  if (status >= 500 || status === 408) {
    return new Error(
      `DUCKMAIL_TRANSIENT_FAILURE: ${operation} failed with status ${status}.`,
    );
  }
  if (status === 404) {
    return new Error(
      `DUCKMAIL_MAILBOX_DELIVERY_FAILURE: ${operation} failed with status 404.`,
    );
  }
  return new Error(`DUCKMAIL_REQUEST_FAILURE: ${operation} failed with status ${status}.`);
}

function readHydraPagePointers(body: unknown): { currentPage?: number; lastPage?: number } {
  const view = asRecord(asRecord(body)["hydra:view"]);
  const currentId = readStringLike(view["@id"]);
  const lastId = readStringLike(view["hydra:last"]);

  const parsePageFromValue = (value: string | undefined): number | undefined => {
    if (!value) {
      return undefined;
    }

    try {
      const url = value.startsWith("http://") || value.startsWith("https://")
        ? new URL(value)
        : new URL(value, "https://duckmail.local");
      const page = Number.parseInt(url.searchParams.get("page") || "", 10);
      return Number.isFinite(page) && page > 0 ? page : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    currentPage: parsePageFromValue(currentId),
    lastPage: parsePageFromValue(lastId),
  };
}

function classifyDuckMailProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("status 429") || normalized.includes("rate limit")) {
    return `DUCKMAIL_CAPACITY_FAILURE: ${message}`;
  }
  if (
    normalized.includes("fetch failed")
    || normalized.includes("timed out")
    || normalized.includes("timeout")
    || normalized.includes("network")
    || normalized.includes("socket hang up")
    || normalized.includes("econnreset")
    || normalized.includes("status 5")
  ) {
    return `DUCKMAIL_TRANSIENT_FAILURE: ${message}`;
  }
  return `DUCKMAIL_PROBE_FAILURE: ${message}`;
}

async function requestJson(
  config: DuckMailConfig,
  method: string,
  path: string,
  options: RequestJsonOptions = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const authToken = options.token || options.apiKey;
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  if (options.jsonBody) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${config.apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers,
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

export function resolveDuckMailConfig(instance: ProviderInstance): DuckMailConfig {
  return {
    apiBase: readMetadata(instance, "apiBase") ?? "https://api.duckmail.sbs",
    preferredDomain: readMetadata(instance, "domain"),
    apiKey: readMetadata(instance, "apiKey"),
    expiresIn: parseOptionalInteger(readMetadata(instance, "expiresIn")),
    passwordLength: parseOptionalInteger(readMetadata(instance, "passwordLength")) ?? 12,
  };
}

export function encodeDuckMailMailboxRef(instanceId: string, mailbox: DuckMailMailboxCredentials): string {
  return `duckmail:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeDuckMailMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): DuckMailMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `duckmail:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email) ?? "";
    const token = readStringLike(payload.token) ?? "";
    const password = readStringLike(payload.password) ?? "";
    const accountId = readStringLike(payload.accountId) ?? "";
    if (!email || !token || !password || !accountId || !email.includes("@")) {
      return undefined;
    }
    return {
      email: email.trim().toLowerCase(),
      token: token.trim(),
      password: password.trim(),
      accountId: accountId.trim(),
    };
  } catch {
    return undefined;
  }
}

export class DuckMailClient {
  public constructor(private readonly config: DuckMailConfig) {}

  public static fromInstance(instance: ProviderInstance): DuckMailClient {
    return new DuckMailClient(resolveDuckMailConfig(instance));
  }

  public async getDomains(): Promise<string[]> {
    const domains = new Set<string>();
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage && page <= 5) {
      const response = await requestJson(
        this.config,
        "GET",
        `/domains${encodeQuery({ page })}`,
        { apiKey: this.config.apiKey },
      );
      if (response.status !== 200) {
        throw buildDuckMailStatusError("getDomains", response.status, response.body);
      }

      const body = response.body;
      const items = Array.isArray(body)
        ? body
        : asRecordList(asRecord(body)["hydra:member"] ?? asRecord(body).items ?? asRecord(body).domains);
      for (const item of items) {
        const domain = readStringLike(item.domain ?? item.name)?.toLowerCase();
        const verified = item.verified ?? item.isVerified ?? true;
        if (domain && verified !== false) {
          domains.add(domain);
        }
      }

      const pagePointers = readHydraPagePointers(body);
      lastPage = Math.max(page, pagePointers.lastPage ?? page);
      page += 1;
    }

    return [...domains];
  }

  public async createMailbox(options: { suggestedLocalPart?: string; maxRetries?: number } = {}): Promise<DuckMailMailboxCredentials> {
    const preferredDomain = this.config.preferredDomain?.trim();
    const domains = await this.getDomains();
    const eligibleDomains = preferredDomain
      ? [preferredDomain, ...domains.filter((item) => item !== preferredDomain)]
      : domains;
    if (eligibleDomains.length === 0) {
      throw new Error("DuckMail returned no available domains.");
    }

    const baseLocalPart = sanitizeLocalPart(options.suggestedLocalPart);
    const maxRetries = options.maxRetries ?? 5;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const localPart = `${baseLocalPart}-${createAlphaNumeric(4).toLowerCase()}`.slice(0, 60);
      const domain = eligibleDomains[attempt % eligibleDomains.length]!;
      const email = `${localPart}@${domain}`;
      const password = createPassword(this.config.passwordLength);

      const createResponse = await requestJson(this.config, "POST", "/accounts", {
        apiKey: this.config.apiKey,
        jsonBody: {
          address: email,
          password,
          ...(this.config.expiresIn ? { expiresIn: this.config.expiresIn } : {}),
        },
      });

      if (createResponse.status !== 200 && createResponse.status !== 201) {
        if ([400, 409, 422].includes(createResponse.status) && attempt < maxRetries - 1) {
          continue;
        }
        throw buildDuckMailStatusError("createAccount", createResponse.status, createResponse.body);
      }

      const account = asRecord(createResponse.body);
      const resolvedEmail = readStringLike(account.address) ?? email;
      const accountId = readStringLike(account.id ?? account.account_id) ?? "";

      const tokenResponse = await requestJson(this.config, "POST", "/token", {
        jsonBody: {
          address: resolvedEmail,
          password,
        },
      });
      if (tokenResponse.status !== 200) {
        throw buildDuckMailStatusError("getToken", tokenResponse.status, tokenResponse.body);
      }

      const token = readStringLike(asRecord(tokenResponse.body).token) ?? "";
      if (!token || !accountId) {
        throw new Error("DuckMail createMailbox returned an incomplete account payload.");
      }

      return {
        email: resolvedEmail,
        token,
        password,
        accountId,
      };
    }

    throw new Error("DuckMail createMailbox exhausted retries.");
  }

  public async listMessages(token: string): Promise<Record<string, unknown>[]> {
    const messages: Record<string, unknown>[] = [];
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage && page <= 3) {
      const response = await requestJson(this.config, "GET", `/messages${encodeQuery({ page })}`, { token });
      if (response.status !== 200) {
        throw buildDuckMailStatusError("listMessages", response.status, response.body);
      }

      const body = response.body;
      const items = Array.isArray(body)
        ? body.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
        : asRecordList(asRecord(body)["hydra:member"] ?? asRecord(body).items ?? asRecord(body).messages);
      messages.push(...items);

      const pagePointers = readHydraPagePointers(body);
      lastPage = Math.max(page, pagePointers.lastPage ?? page);
      page += 1;
    }

    return messages;
  }

  public async getMessage(token: string, messageId: string): Promise<Record<string, unknown>> {
    const response = await requestJson(
      this.config,
      "GET",
      `/messages/${encodeURIComponent(messageId)}`,
      { token },
    );
    if (response.status === 404) {
      return {};
    }
    if (response.status !== 200) {
      throw buildDuckMailStatusError("getMessage", response.status, response.body);
    }

    return asRecord(response.body);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: DuckMailMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.listMessages(mailbox.token);
    const fromContainsNormalized = normalizeFromContains(fromContains);

    for (const item of messages) {
      const messageId = readStringLike(item.id ?? item["@id"]);
      if (!messageId) {
        continue;
      }

      const sender = readSender(item.from);
      if (!matchesSenderFilter(sender, fromContainsNormalized)) {
        continue;
      }

      const summarySubject = readStringLike(item.subject);
      const summaryIntro = readStringLike(item.intro ?? item.snippet ?? item.bodyPreview);
      const summaryOtp = extractOtp({
        subject: summarySubject,
        textBody: summaryIntro,
      });
      if (summaryOtp) {
        return {
          id: `duckmail:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: readStringLike(item.createdAt) ?? "",
          sender,
          subject: summarySubject,
          textBody: summaryIntro,
          extractedCode: summaryOtp.code,
          codeSource: summaryOtp.source,
        };
      }

      const detail = await this.getMessage(mailbox.token, messageId);
      const detailSender = readSender(detail.from) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContainsNormalized)) {
        continue;
      }

      const detailSubject = readStringLike(detail.subject) ?? summarySubject;
      const textBody = readStringLike(detail.text ?? detail.body);
      const htmlBody = readStringLike(detail.html);
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody,
        htmlBody,
      });
      return {
        id: `duckmail:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: readStringLike(detail.createdAt) ?? "",
        sender: detailSender,
        subject: detailSubject,
        textBody,
        htmlBody,
        extractedCode: detailOtp?.code,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeDuckMailInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
}> {
  const client = DuckMailClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? `DUCKMAIL_PROBE_OK: DuckMail returned ${domains.length} available domains.`
        : "DUCKMAIL_MAILBOX_DELIVERY_FAILURE: DuckMail returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      detail: classifyDuckMailProbeError(error),
      averageLatencyMs: Date.now() - startedAt,
    };
  }
}
