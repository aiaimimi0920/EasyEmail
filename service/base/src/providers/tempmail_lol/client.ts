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

export interface TempmailLolConfig {
  apiBase: string;
}

export interface TempmailLolMailboxCredentials {
  email: string;
  token: string;
}

const TEMPMAIL_LOL_USER_AGENT = "TempMailJS/4.4.0";
const TEMPMAIL_LOL_MAX_RETRIES = 2;
const TEMPMAIL_LOL_RETRY_BASE_DELAY_MS = 700;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2})/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota)/i;

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

function encodeQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function classifyTempmailLolError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

function formatTempmailLolError(phase: string, status: number): Error {
  const rawMessage = `Tempmail.lol ${phase} failed with status ${status}.`;
  const category = classifyTempmailLolError(rawMessage);
  if (category === "capacity") {
    return new Error(`TEMPMAIL_LOL_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`TEMPMAIL_LOL_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`TEMPMAIL_LOL_PROVIDER_FAILURE: ${rawMessage}`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function requestRaw(
  config: TempmailLolConfig,
  method: string,
  path: string,
  options: { jsonBody?: Record<string, unknown> } = {},
): Promise<{ status: number; bodyText: string }> {
  const normalizedBase = config.apiBase.replace(/\/$/, "");

  for (let attempt = 0; attempt <= TEMPMAIL_LOL_MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${normalizedBase}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": TEMPMAIL_LOL_USER_AGENT,
        ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
      },
      body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
    });

    const bodyText = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < TEMPMAIL_LOL_MAX_RETRIES) {
      await sleep(TEMPMAIL_LOL_RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }

    return {
      status: response.status,
      bodyText,
    };
  }

  return {
    status: 599,
    bodyText: "",
  };
}

async function requestJson(
  config: TempmailLolConfig,
  method: string,
  path: string,
  options: { jsonBody?: Record<string, unknown> } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await requestRaw(config, method, path, options);
  if (!response.bodyText) {
    return { status: response.status, body: {} };
  }

  try {
    return {
      status: response.status,
      body: JSON.parse(response.bodyText),
    };
  } catch {
    return {
      status: response.status,
      body: response.bodyText,
    };
  }
}

export function resolveTempmailLolConfig(instance: ProviderInstance): TempmailLolConfig {
  return {
    apiBase: readMetadata(instance, "apiBase") ?? "https://api.tempmail.lol/v2",
  };
}

export function encodeTempmailLolMailboxRef(instanceId: string, mailbox: TempmailLolMailboxCredentials): string {
  return `tempmail-lol:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeTempmailLolMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): TempmailLolMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `tempmail-lol:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email) ?? "";
    const token = readStringLike(payload.token) ?? "";
    if (!email || !token || !email.includes("@")) {
      return undefined;
    }
    return { email: email.trim().toLowerCase(), token: token.trim() };
  } catch {
    return undefined;
  }
}

export class TempmailLolClient {
  public constructor(private readonly config: TempmailLolConfig) {}

  public static fromInstance(instance: ProviderInstance): TempmailLolClient {
    return new TempmailLolClient(resolveTempmailLolConfig(instance));
  }

  public async createMailbox(): Promise<TempmailLolMailboxCredentials> {
    const response = await requestJson(this.config, "POST", "/inbox/create", { jsonBody: {} });
    if (response.status !== 200 && response.status !== 201) {
      throw formatTempmailLolError("createMailbox", response.status);
    }

    const body = asRecord(response.body);
    const email = readStringLike(body.address) ?? "";
    const token = readStringLike(body.token) ?? "";
    if (!email || !token) {
      throw new Error("Tempmail.lol createMailbox returned an incomplete mailbox payload.");
    }

    return { email, token };
  }

  public async getInbox(token: string): Promise<Record<string, unknown>> {
    const response = await requestJson(this.config, "GET", `/inbox${encodeQuery({ token })}`);
    if (response.status === 429 || response.status >= 500) {
      throw formatTempmailLolError("getInbox", response.status);
    }
    if (response.status !== 200) {
      return {};
    }

    return asRecord(response.body);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: TempmailLolMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const inbox = await this.getInbox(mailbox.token);
    const emails = asRecordList(inbox.emails ?? inbox.messages);

    for (const item of emails) {
      const sender = readStringLike(item.from ?? item.sender);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const subject = readStringLike(item.subject);
      const textBody = readStringLike(item.body ?? item.text);
      const htmlBody = readStringLike(item.html);
      const extractedOtp = extractOtp({
        subject,
        textBody,
        htmlBody,
      });
      if (!extractedOtp) {
        const messageId = readStringLike(item.id)
          ?? readStringLike(item.date)
          ?? readStringLike(item.createdAt)
          ?? sessionId;
        return {
          id: `tempmail-lol:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: readStringLike(item.createdAt ?? item.date) ?? "",
          sender,
          subject,
          textBody,
          htmlBody,
        };
      }

      const messageId = readStringLike(item.id)
        ?? readStringLike(item.date)
        ?? readStringLike(item.createdAt)
        ?? extractedOtp.code;

      return {
        id: `tempmail-lol:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: readStringLike(item.createdAt ?? item.date) ?? "",
        sender,
        subject,
        textBody,
        htmlBody,
        extractedCode: extractedOtp.code,
        codeSource: extractedOtp.source,
      };
    }

    return undefined;
  }
}

export async function probeTempmailLolInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const config = resolveTempmailLolConfig(instance);
  const startedAt = Date.now();
  try {
    const response = await requestRaw(config, "POST", "/inbox/create", { jsonBody: {} });
    const detail = `Tempmail.lol probe responded with HTTP ${response.status}.`;
    return {
      ok: response.status === 200 || response.status === 201,
      detail: response.status === 200 || response.status === 201
        ? `TEMPMAIL_LOL_PROBE_OK: ${detail}`
        : `TEMPMAIL_LOL_PROVIDER_FAILURE: ${detail}`,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "tempmail-lol",
        state: response.status === 200 || response.status === 201 ? "ok" : "unexpected-status",
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const classification = classifyTempmailLolError(detail);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "tempmail-lol",
        errorClass: classification,
      },
    };
  }
}
