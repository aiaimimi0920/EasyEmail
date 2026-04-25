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

export interface GuerrillaMailConfig {
  apiBase: string;
  preferredDomain?: string;
}

export interface GuerrillaMailMailboxCredentials {
  emailAddress: string;
  emailUser: string;
  sidToken: string;
}

interface GuerrillaMailMessageSummary {
  mail_id?: unknown;
  mail_subject?: unknown;
  mail_excerpt?: unknown;
  mail_from?: unknown;
  mail_timestamp?: unknown;
}

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

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
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
  const normalizedSender = readString(sender)?.toLowerCase();
  if (!normalizedSender) {
    return false;
  }
  return normalizedSender.includes(normalizedFilter);
}

function extractOtp(values: { subject?: unknown; textBody?: unknown; htmlBody?: unknown }) {
  return extractOtpFromContent({
    subject: readString(values.subject),
    textBody: readString(values.textBody),
    htmlBody: readString(values.htmlBody),
  });
}

function createRandomSuffix(length: number): string {
  return randomBytes(Math.max(8, length))
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, length);
}

function sanitizeEmailUser(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "");
  const startsWithLetter = /^[a-z]/.test(normalized);
  const withPrefix = startsWithLetter ? normalized : `g${normalized}`;
  const collapsed = withPrefix.replace(/^[^a-z]+/, "g");
  return (collapsed || `g${createRandomSuffix(8).toLowerCase()}`).slice(0, 28);
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      const millis = parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
      return new Date(millis).toISOString();
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return "";
}

function encodeQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function classifyGuerrillaMailError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

function formatGuerrillaMailError(phase: string, status: number): Error {
  const rawMessage = `GuerrillaMail ${phase} failed with status ${status}.`;
  const category = classifyGuerrillaMailError(rawMessage);
  if (category === "capacity") {
    return new Error(`GUERRILLAMAIL_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`GUERRILLAMAIL_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`GUERRILLAMAIL_PROVIDER_FAILURE: ${rawMessage}`);
}

async function requestJson(
  config: GuerrillaMailConfig,
  params: Record<string, string | number | undefined>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${config.apiBase}${encodeQuery(params)}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
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

export function resolveGuerrillaMailConfig(instance: ProviderInstance): GuerrillaMailConfig {
  return {
    apiBase: readMetadata(instance, "apiBase") ?? "https://api.guerrillamail.com/ajax.php",
    preferredDomain: readMetadata(instance, "domain"),
  };
}

export function encodeGuerrillaMailMailboxRef(
  instanceId: string,
  mailbox: GuerrillaMailMailboxCredentials,
): string {
  return `guerrillamail:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeGuerrillaMailMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): GuerrillaMailMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `guerrillamail:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const emailAddress = readString(payload.emailAddress) ?? "";
    const emailUser = readString(payload.emailUser) ?? "";
    const sidToken = readString(payload.sidToken) ?? "";
    if (!emailAddress || !emailUser || !sidToken || !emailAddress.includes("@")) {
      return undefined;
    }
    return {
      emailAddress: emailAddress.trim().toLowerCase(),
      emailUser: emailUser.trim().toLowerCase(),
      sidToken: sidToken.trim(),
    };
  } catch {
    return undefined;
  }
}

export class GuerrillaMailClient {
  public constructor(private readonly config: GuerrillaMailConfig) {}

  public static fromInstance(instance: ProviderInstance): GuerrillaMailClient {
    return new GuerrillaMailClient(resolveGuerrillaMailConfig(instance));
  }

  public async getEmailAddress(sidToken?: string): Promise<Record<string, unknown>> {
    const response = await requestJson(this.config, {
      f: "get_email_address",
      sid_token: sidToken,
      lang: "en",
    });
    if (response.status !== 200) {
      throw formatGuerrillaMailError("get_email_address", response.status);
    }
    return asRecord(response.body);
  }

  public async setEmailUser(emailUser: string, sidToken?: string): Promise<Record<string, unknown>> {
    const response = await requestJson(this.config, {
      f: "set_email_user",
      email_user: emailUser,
      email_domain: this.config.preferredDomain,
      sid_token: sidToken,
      lang: "en",
    });
    if (response.status !== 200) {
      throw formatGuerrillaMailError("set_email_user", response.status);
    }
    return asRecord(response.body);
  }

  public async getEmailList(sidToken: string, offset = 0): Promise<GuerrillaMailMessageSummary[]> {
    const response = await requestJson(this.config, {
      f: "get_email_list",
      offset,
      sid_token: sidToken,
      lang: "en",
    });
    if (response.status !== 200) {
      throw formatGuerrillaMailError("get_email_list", response.status);
    }

    const body = asRecord(response.body);
    return asRecordList(body.list) as GuerrillaMailMessageSummary[];
  }

  public async fetchEmail(sidToken: string, emailId: string): Promise<Record<string, unknown>> {
    const response = await requestJson(this.config, {
      f: "fetch_email",
      email_id: emailId,
      sid_token: sidToken,
      lang: "en",
    });
    if (response.status === 429 || response.status >= 500) {
      throw formatGuerrillaMailError("fetch_email", response.status);
    }
    if (response.status !== 200) {
      return {};
    }
    return asRecord(response.body);
  }

  public async createMailbox(options: { suggestedEmailUser?: string } = {}): Promise<GuerrillaMailMailboxCredentials> {
    const suggested = sanitizeEmailUser(options.suggestedEmailUser);
    const seeded = await this.setEmailUser(`${suggested}${createRandomSuffix(4).toLowerCase()}`);
    const sidToken = readString(seeded.sid_token);
    const emailAddress = readString(seeded.email_addr);
    const emailUser = readString(seeded.email_user) ?? sanitizeEmailUser(emailAddress?.split("@", 1)[0]);
    if (sidToken && emailAddress && emailUser) {
      return { sidToken, emailAddress, emailUser };
    }

    const fallback = await this.getEmailAddress(sidToken);
    const fallbackToken = readString(fallback.sid_token) ?? sidToken ?? "";
    const fallbackAddress = readString(fallback.email_addr) ?? emailAddress ?? "";
    const fallbackUser = readString(fallback.email_user) ?? emailUser ?? sanitizeEmailUser(fallbackAddress.split("@", 1)[0]);
    if (!fallbackToken || !fallbackAddress || !fallbackUser) {
      throw new Error("GuerrillaMail createMailbox returned an incomplete mailbox payload.");
    }

    return {
      sidToken: fallbackToken,
      emailAddress: fallbackAddress,
      emailUser: fallbackUser,
    };
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: GuerrillaMailMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.getEmailList(mailbox.sidToken, 0);
    const sorted = [...messages].sort((left, right) => {
      const leftTs = Number.parseInt(String(left.mail_timestamp ?? "0"), 10) || 0;
      const rightTs = Number.parseInt(String(right.mail_timestamp ?? "0"), 10) || 0;
      return rightTs - leftTs;
    });

    for (const item of sorted) {
      const messageId = String(item.mail_id ?? "").trim();
      if (!messageId) {
        continue;
      }

      const sender = readString(item.mail_from);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const subject = readString(item.mail_subject);
      const excerpt = readString(item.mail_excerpt);
      const summaryOtp = extractOtp({
        subject,
        textBody: excerpt,
      });
      if (summaryOtp) {
        return {
          id: `guerrillamail:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: toIsoTimestamp(item.mail_timestamp),
          sender,
          subject,
          textBody: excerpt,
          extractedCode: summaryOtp.code,
          codeSource: summaryOtp.source,
        };
      }

      const detail = await this.fetchEmail(mailbox.sidToken, messageId);
      const detailSender = readString(detail.mail_from) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContains)) {
        continue;
      }

      const detailSubject = readString(detail.mail_subject) ?? subject;
      const textBody = excerpt;
      const htmlBody = readString(detail.mail_body);
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody,
        htmlBody,
      });
      if (!detailOtp) {
        continue;
      }
      return {
        id: `guerrillamail:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: toIsoTimestamp(detail.mail_timestamp ?? item.mail_timestamp),
        sender: detailSender,
        subject: detailSubject,
        textBody,
        htmlBody,
        extractedCode: detailOtp.code,
        codeSource: detailOtp.source,
      };
    }

    return undefined;
  }
}

export async function probeGuerrillaMailInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = GuerrillaMailClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const address = await client.getEmailAddress();
    const emailAddress = readString(address.email_addr);
    const sidToken = readString(address.sid_token);
    return {
      ok: Boolean(emailAddress && sidToken),
      detail: emailAddress
        ? `GUERRILLAMAIL_PROBE_OK: GuerrillaMail probe resolved mailbox ${emailAddress}.`
        : "GUERRILLAMAIL_MAILBOX_DELIVERY_FAILURE: GuerrillaMail probe returned no mailbox address.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "guerrillamail",
        ...(emailAddress ? { emailAddress } : {}),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const classification = classifyGuerrillaMailError(detail);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "guerrillamail",
        errorClass: classification,
      },
    };
  }
}
