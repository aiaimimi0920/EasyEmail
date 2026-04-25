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

import {
  createValueCredentialSetFromFile,
  markCredentialCriticalFailure,
  markCredentialFailure,
  markCredentialSuccess,
  parseCredentialSetsJson,
  selectCredentialItem,
  type CredentialSelection,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";

export interface MoemailConfig {
  instanceId: string;
  namespace: string;
  apiBase: string;
  credentialSets: CredentialSetDefinition[];
  preferredDomain?: string;
  expiryTimeMs: number;
  webSessionToken?: string;
  webCsrfToken?: string;
  webCallbackUrl?: string;
  webReferer?: string;
}

export interface MoemailMailboxCredentials {
  emailId: string;
  email: string;
  localPart?: string;
  domain?: string;
}

export interface MoemailMailboxListingEntry {
  emailId: string;
  email: string;
  createdAt?: string;
  expiresAt?: string;
}

interface MoemailMessageSummary {
  messageId: string;
  sender?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  observedAt: string;
}

interface MoemailMailboxAccessCheckResult {
  status: "accessible" | "missing" | MoemailClientError["kind"];
}

export interface ClassifiedMoemailFailure {
  kind: "auth" | "capacity" | "transient" | "provider";
  message: string;
  status?: number;
  mailboxConflict: boolean;
}

class MoemailClientError extends Error {
  public constructor(
    message: string,
    public readonly kind: "auth" | "capacity" | "transient" | "provider",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MoemailClientError";
  }
}

const MOEMAIL_MAX_MAILBOX_LIMIT_RE = /(已达到最大邮箱数量限制|最大邮箱数量限制|maximum mailbox|max mailbox|mailbox count limit|mailbox quantity limit)/i;
const AUTH_ERROR_RE = /(status 401|status 403|forbidden|unauthorized|api key|openapi access|permission|role)/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|limit exceeded)/i;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2}|gateway)/i;

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

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item)).join("\n").trim();
    return normalized || undefined;
  }
  return undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function createLocalPartSeed(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return normalized || `m${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeEmailAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return undefined;
  }
  return normalized;
}

function splitEmailAddress(
  value: string | undefined,
): { email: string; localPart: string; domain: string } | undefined {
  const normalized = normalizeEmailAddress(value);
  if (!normalized) {
    return undefined;
  }
  const [localPart, domain] = normalized.split("@", 2);
  if (!localPart || !domain) {
    return undefined;
  }
  return {
    email: normalized,
    localPart,
    domain,
  };
}

function isMailboxAlreadyUsedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("status 409")
    && (
      normalized.includes("该邮箱地址已被使用")
      || normalized.includes("address already used")
      || normalized.includes("email address already used")
      || normalized.includes("already exists")
    )
  );
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return "";
}

function classifyMoemailError(message: string): MoemailClientError["kind"] {
  const normalized = message.trim().toLowerCase();
  if (MOEMAIL_MAX_MAILBOX_LIMIT_RE.test(normalized)) {
    return "capacity";
  }
  if (AUTH_ERROR_RE.test(normalized)) {
    return "auth";
  }
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

function classifyThrownError(error: unknown): MoemailClientError {
  if (error instanceof MoemailClientError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new MoemailClientError(message, classifyMoemailError(message));
}

export function classifyMoemailFailure(error: unknown): ClassifiedMoemailFailure {
  const classified = classifyThrownError(error);
  return {
    kind: classified.kind,
    message: classified.message,
    status: classified.status,
    mailboxConflict: isMailboxAlreadyUsedError(error),
  };
}

function buildStatusError(phase: string, status: number, body: unknown): MoemailClientError {
  const bodyRecord = asRecord(body);
  const detail = readString(bodyRecord.message)
    ?? readString(bodyRecord.error)
    ?? readString(bodyRecord.detail)
    ?? (typeof body === "string" ? body.trim() : undefined);
  const message = `MoEmail ${phase} failed with status ${status}.${detail ? ` ${detail}` : ""}`;
  return new MoemailClientError(message, classifyMoemailError(message), status);
}

async function requestJson(
  config: MoemailConfig,
  apiKey: string,
  method: string,
  path: string,
  options: {
    jsonBody?: Record<string, unknown>;
    cursor?: string;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, config.apiBase.endsWith("/") ? config.apiBase : `${config.apiBase}/`);
  if (options.cursor?.trim()) {
    url.searchParams.set("cursor", options.cursor.trim());
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
        ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
      },
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
  } catch (error) {
    throw classifyThrownError(error);
  }
}

function createInlineCredentialSet(apiKey: string | undefined): CredentialSetDefinition | undefined {
  if (!apiKey?.trim()) {
    return undefined;
  }
  return {
    id: "inline-default",
    displayName: "Inline MoEmail API Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    items: [{ id: "inline-key", label: "Inline Key", value: apiKey.trim(), metadata: {} }],
    metadata: {},
  };
}

export function resolveMoemailCredentialSets(instance: ProviderInstance): CredentialSetDefinition[] {
  const configured = parseCredentialSetsJson(readMetadata(instance, "credentialSetsJson"));
  if (configured.length > 0) {
    return configured;
  }

  const inlineSet = createInlineCredentialSet(readMetadata(instance, "apiKey"));
  const fileSet = createValueCredentialSetFromFile(readMetadata(instance, "keysFile"), {
    id: "keys-file",
    displayName: "MoEmail Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  return [inlineSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);
}

export function resolveMoemailConfig(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
  options: {
    namespace?: string;
  } = {},
): MoemailConfig {
  return {
    instanceId: instance.id,
    namespace: options.namespace?.trim() || `mail:moemail:${instance.id}`,
    apiBase: readMetadata(instance, "apiBase") ?? "https://moemail.app",
    credentialSets: credentialSets && credentialSets.length > 0
      ? credentialSets
      : resolveMoemailCredentialSets(instance),
    preferredDomain: readMetadata(instance, "domain"),
    expiryTimeMs: parseOptionalInteger(readMetadata(instance, "expiryTimeMs")) ?? 3600000,
    webSessionToken: readMetadata(instance, "webSessionToken"),
    webCsrfToken: readMetadata(instance, "webCsrfToken"),
    webCallbackUrl: readMetadata(instance, "webCallbackUrl"),
    webReferer: readMetadata(instance, "webReferer"),
  };
}

function extractMailboxPayload(
  body: unknown,
  fallbackLocalPart?: string,
  fallbackDomain?: string,
): MoemailMailboxCredentials | undefined {
  const record = asRecord(body);
  const candidates = [
    record,
    asRecord(record.data),
    asRecord(record.email),
    asRecord(record.mailbox),
    asRecord(asRecord(record.data).email),
    asRecord(asRecord(record.data).mailbox),
    asRecord(asRecord(record.result).email),
    asRecord(asRecord(record.result).mailbox),
  ];

  for (const candidate of candidates) {
    const emailId = readString(candidate.emailId)
      ?? readString(candidate.id)
      ?? readString(candidate._id)
      ?? readString(candidate.mailboxId);
    const email = (readString(candidate.emailAddress)
      ?? readString(candidate.address)
      ?? readString(candidate.email)
      ?? readString(candidate.mailbox))?.toLowerCase();
    const localPart = readString(candidate.name)
      ?? readString(candidate.localPart)
      ?? email?.split("@", 1)[0]
      ?? fallbackLocalPart;
    const domain = readString(candidate.domain)
      ?? email?.split("@").slice(1).join("@")
      ?? fallbackDomain;

    if (emailId && (email || (localPart && domain))) {
      const resolvedEmail = email ?? `${localPart!}@${domain!}`.toLowerCase();
      if (!resolvedEmail.includes("@")) {
        continue;
      }
      return {
        emailId,
        email: resolvedEmail,
        localPart,
        domain,
      };
    }
  }

  return undefined;
}

function extractMailboxListingEntries(
  body: unknown,
): { emails: MoemailMailboxListingEntry[]; nextCursor?: string; total?: number } {
  const record = asRecord(body);
  const payloads = [
    record,
    asRecord(record.data),
    asRecord(record.result),
  ];

  for (const payload of payloads) {
    const items = asRecordList(payload.emails ?? payload.items ?? payload.list);
    if (items.length <= 0) {
      continue;
    }

    const emails: MoemailMailboxListingEntry[] = [];
    for (const item of items) {
      const emailId = readString(item.id)
        ?? readString(item.emailId)
        ?? readString(item._id)
        ?? readString(item.mailboxId);
      const email = (
        readString(item.address)
        ?? readString(item.email)
        ?? readString(item.emailAddress)
        ?? readString(item.mailbox)
      )?.toLowerCase();
      if (!emailId || !email) {
        continue;
      }
      emails.push({
        emailId,
        email,
        createdAt: readString(item.createdAt) ?? readString(item.created_at),
        expiresAt: readString(item.expiresAt) ?? readString(item.expires_at),
      });
    }

    return {
      emails,
      nextCursor: readString(payload.nextCursor) ?? readString(payload.cursor),
      total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : undefined,
    };
  }

  return {
    emails: [],
    nextCursor: readString(record.nextCursor) ?? readString(record.cursor),
    total: Number.isFinite(Number(record.total)) ? Number(record.total) : undefined,
  };
}

function extractMessageEntries(body: unknown): { items: Record<string, unknown>[]; nextCursor?: string } {
  const record = asRecord(body);
  const payload = [
    record,
    asRecord(record.data),
    asRecord(record.result),
  ];

  for (const candidate of payload) {
    const items = asRecordList(candidate.messages ?? candidate.items ?? candidate.list);
    if (items.length > 0) {
      return {
        items,
        nextCursor: readString(candidate.nextCursor) ?? readString(candidate.cursor),
      };
    }
  }

  return {
    items: [],
    nextCursor: readString(record.nextCursor) ?? readString(record.cursor),
  };
}

function readMessageId(record: Record<string, unknown>): string | undefined {
  return readString(record.messageId)
    ?? readString(record.id)
    ?? readString(record._id)
    ?? readString(record.mailId);
}

function readMessageSender(record: Record<string, unknown>): string | undefined {
  const from = record.from;
  if (from && typeof from === "object" && Array.isArray(from) === false) {
    return readString((from as Record<string, unknown>).address)
      ?? readString((from as Record<string, unknown>).email)
      ?? readString((from as Record<string, unknown>).name)
      ?? readString((from as Record<string, unknown>).from);
  }
  return readString(record.from)
    ?? readString(record.sender)
    ?? readString(record.fromAddress)
    ?? readString(record.senderAddress);
}

function readMessageSubject(record: Record<string, unknown>): string | undefined {
  return readString(record.subject) ?? readString(record.title);
}

function readMessageText(record: Record<string, unknown>): string | undefined {
  return readString(record.text)
    ?? readString(record.textBody)
    ?? readString(record.body)
    ?? readString(record.content)
    ?? readString(record.preview)
    ?? readString(record.snippet)
    ?? readString(record.summary);
}

function readMessageHtml(record: Record<string, unknown>): string | undefined {
  return readString(record.html)
    ?? readString(record.htmlBody)
    ?? readString(record.htmlContent)
    ?? readString(record.rawHtml);
}

function summarizeMessage(record: Record<string, unknown>): MoemailMessageSummary | undefined {
  const messageId = readMessageId(record);
  if (!messageId) {
    return undefined;
  }
  return {
    messageId,
    sender: readMessageSender(record),
    subject: readMessageSubject(record),
    textBody: readMessageText(record),
    htmlBody: readMessageHtml(record),
    observedAt: toIsoTimestamp(
      record.received_at
      ?? record.receivedAt
      ?? record.sent_at
      ?? record.createdAt
      ?? record.created_at
      ?? record.updatedAt
      ?? record.updated_at
      ?? record.timestamp,
    ),
  };
}

export class MoemailClient {
  public constructor(private readonly config: MoemailConfig) {}

  private async listEmailsWithApiKey(
    apiKey: string,
    cursor?: string,
  ): Promise<{ emails: MoemailMailboxListingEntry[]; nextCursor?: string; total?: number }> {
    const response = await requestJson(
      this.config,
      apiKey,
      "GET",
      "/api/emails",
      { cursor },
    );

    if (response.status !== 200) {
      throw buildStatusError("listEmails", response.status, response.body);
    }

    return extractMailboxListingEntries(response.body);
  }

  private async listMailboxMessagesWithApiKey(
    apiKey: string,
    emailId: string,
    cursor?: string,
  ): Promise<{ items: MoemailMessageSummary[]; nextCursor?: string }> {
    const response = await requestJson(this.config, apiKey, "GET", `/api/emails/${encodeURIComponent(emailId)}`, {
      cursor,
    });

    if (response.status === 404) {
      return { items: [] };
    }
    if (response.status !== 200) {
      throw buildStatusError("listMailboxMessages", response.status, response.body);
    }

    const extracted = extractMessageEntries(response.body);
    return {
      items: extracted.items
        .map((item) => summarizeMessage(item))
        .filter((item): item is MoemailMessageSummary => item !== undefined),
      nextCursor: extracted.nextCursor,
    };
  }

  private async findMailboxByEmailAddressWithApiKey(
    apiKey: string,
    emailAddress: string,
    maxPages = 50,
  ): Promise<MoemailMailboxCredentials | undefined> {
    const identity = splitEmailAddress(emailAddress);
    if (!identity) {
      return undefined;
    }

    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.listEmailsWithApiKey(apiKey, cursor);
      for (const entry of page.emails) {
        if (entry.email.trim().toLowerCase() !== identity.email) {
          continue;
        }
        return {
          emailId: entry.emailId,
          email: entry.email,
          localPart: identity.localPart,
          domain: identity.domain,
        };
      }
      cursor = page.nextCursor?.trim() || undefined;
      if (!cursor) {
        break;
      }
    }

    return undefined;
  }

  private async inspectMailboxAccessWithApiKey(
    apiKey: string,
    mailbox: MoemailMailboxCredentials,
  ): Promise<MoemailMailboxAccessCheckResult> {
    try {
      const response = await requestJson(
        this.config,
        apiKey,
        "GET",
        `/api/emails/${encodeURIComponent(mailbox.emailId)}`,
      );

      if (response.status >= 200 && response.status < 300) {
        return { status: "accessible" };
      }

      if (response.status === 404) {
        return { status: "missing" };
      }

      return {
        status: classifyThrownError(
          buildStatusError("inspectMailboxAccess", response.status, response.body),
        ).kind,
      };
    } catch (error) {
      return {
        status: classifyThrownError(error).kind,
      };
    }
  }

  private async generateMailboxWithApiKey(
    apiKey: string,
    options: {
      localPart: string;
      expiryTime?: number;
      domain?: string;
    },
  ): Promise<MoemailMailboxCredentials> {
    const response = await requestJson(this.config, apiKey, "POST", "/api/emails/generate", {
      jsonBody: {
        name: options.localPart,
        expiryTime: options.expiryTime ?? this.config.expiryTimeMs,
        ...(options.domain ? { domain: options.domain } : {}),
      },
    });

    if (response.status !== 200 && response.status !== 201) {
      throw buildStatusError("generateMailbox", response.status, response.body);
    }

    const mailbox = extractMailboxPayload(response.body, options.localPart, options.domain);
    if (!mailbox) {
      throw new MoemailClientError(
        "MoEmail generate mailbox returned an incomplete mailbox payload.",
        "provider",
      );
    }

    return mailbox;
  }

  private async deleteMailboxWithApiKey(
    apiKey: string,
    emailId: string,
    useCase: "generate" | "poll" = "poll",
  ): Promise<{ released: boolean; detail: string }> {
    const response = await requestJson(
      this.config,
      apiKey,
      "DELETE",
      `/api/emails/${encodeURIComponent(emailId)}`,
    );

    if (response.status === 404) {
      return {
        released: false,
        detail: "already_deleted",
      };
    }
    if (response.status !== 200 && response.status !== 204) {
      throw buildStatusError(`deleteMailbox:${useCase}`, response.status, response.body);
    }

    return {
      released: true,
      detail: "deleted",
    };
  }

  private async recoverRequestedMailboxConflict(
    apiKey: string,
    error: unknown,
    options: {
      requestedEmail?: string;
      localPart: string;
      expiryTime?: number;
      domain?: string;
    },
  ): Promise<MoemailMailboxCredentials | undefined> {
    const requestedEmail = normalizeEmailAddress(options.requestedEmail);
    if (!requestedEmail || !isMailboxAlreadyUsedError(error)) {
      return undefined;
    }

    const existing = await this.findMailboxByEmailAddressWithApiKey(apiKey, requestedEmail);
    if (!existing) {
      return undefined;
    }

    const mailboxAccess = await this.inspectMailboxAccessWithApiKey(apiKey, existing);
    if (mailboxAccess.status === "accessible") {
      return existing;
    }

    if (mailboxAccess.status !== "missing") {
      return undefined;
    }

    await this.deleteMailbox(existing.emailId, "generate");

    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      if (attemptIndex > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attemptIndex));
      }
      try {
        return await this.generateMailboxWithApiKey(apiKey, {
          localPart: options.localPart,
          expiryTime: options.expiryTime,
          domain: options.domain,
        });
      } catch (retryError) {
        if (!isMailboxAlreadyUsedError(retryError) || attemptIndex >= 2) {
          throw retryError;
        }
      }
    }

    return undefined;
  }

  public async recoverMailboxByEmailAddress(
    emailAddress: string,
  ): Promise<{ mailbox: MoemailMailboxCredentials; strategy: "account_restore" | "recreate_same_address" } | undefined> {
    const requestedEmail = normalizeEmailAddress(emailAddress);
    if (!requestedEmail) {
      return undefined;
    }

    return this.withCredential("generate", requestedEmail, async (_selection, apiKey) => {
      const requestedIdentity = splitEmailAddress(requestedEmail);
      if (!requestedIdentity) {
        return undefined;
      }

      const existing = await this.findMailboxByEmailAddressWithApiKey(apiKey, requestedEmail);
      if (existing) {
        const mailboxAccess = await this.inspectMailboxAccessWithApiKey(apiKey, existing);
        if (mailboxAccess.status === "accessible") {
          return {
            mailbox: existing,
            strategy: "account_restore" as const,
          };
        }
        if (mailboxAccess.status !== "missing") {
          return undefined;
        }
        await this.deleteMailboxWithApiKey(apiKey, existing.emailId, "generate");
      }

      try {
        const mailbox = await this.generateMailboxWithApiKey(apiKey, {
          localPart: requestedIdentity.localPart,
          expiryTime: this.config.expiryTimeMs,
          domain: requestedIdentity.domain,
        });
        return {
          mailbox,
          strategy: "recreate_same_address" as const,
        };
      } catch (error) {
        const recovered = await this.recoverRequestedMailboxConflict(apiKey, error, {
          requestedEmail,
          localPart: requestedIdentity.localPart,
          expiryTime: this.config.expiryTimeMs,
          domain: requestedIdentity.domain,
        });
        if (!recovered) {
          return undefined;
        }
        return {
          mailbox: recovered,
          strategy: "recreate_same_address" as const,
        };
      }
    });
  }

  public static fromInstance(
    instance: ProviderInstance,
    credentialSets?: CredentialSetDefinition[],
    options: {
      namespace?: string;
    } = {},
  ): MoemailClient | undefined {
    const config = resolveMoemailConfig(instance, credentialSets, options);
    if (config.credentialSets.length === 0) {
      return undefined;
    }

    return new MoemailClient(config);
  }

  private countCandidateItems(useCase: "generate" | "poll"): number {
    return this.config.credentialSets
      .filter((set) => set.useCases.includes(useCase))
      .reduce((sum, set) => sum + set.items.length, 0);
  }

  private select(useCase: "generate" | "poll", stickyKey?: string): CredentialSelection | undefined {
    return selectCredentialItem({
      namespace: this.config.namespace,
      sets: this.config.credentialSets,
      useCase,
      stickyKey,
    });
  }

  private handleCredentialFailure(selection: CredentialSelection, error: unknown): MoemailClientError {
    const classified = classifyThrownError(error);
    if (classified.kind === "auth") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        error: classified.message,
      });
      return classified;
    }
    if (classified.kind === "capacity") {
      // MoEmail mailbox count limits clear automatically as short-lived inboxes expire.
      // Keep only a short retry backoff so the provider is not escalated into reset-window cooling.
      markCredentialFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        cooldownMs: 2_000,
        error: classified.message,
      });
      return classified;
    }

    if (classified.kind === "provider") {
      // Generic provider-side failures should not permanently poison the only
      // configured key. MoEmail occasionally returns provider errors while the
      // credential remains valid, so treat them as timed cooling instead of a
      // reset-window critical failure.
      markCredentialFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        cooldownMs: 5_000,
        error: classified.message,
      });
      return classified;
    }

    markCredentialFailure(this.config.namespace, selection.set, selection.item, {
      status: "cooling",
      cooldownMs: classified.kind === "transient" ? 5_000 : 5_000,
      error: classified.message,
    });
    return classified;
  }

  private async withCredential<T>(
    useCase: "generate" | "poll",
    stickyKey: string | undefined,
    callback: (selection: CredentialSelection, apiKey: string) => Promise<T>,
  ): Promise<T> {
    const attempts = Math.max(1, this.countCandidateItems(useCase));
    let lastError: Error | undefined;

    for (let index = 0; index < attempts; index += 1) {
      const selection = this.select(useCase, stickyKey);
      if (!selection) {
        break;
      }

      const apiKey = selection.item.value?.trim();
      if (!apiKey) {
        lastError = this.handleCredentialFailure(
          selection,
          new MoemailClientError("Selected MoEmail credential is missing key value.", "auth"),
        );
        continue;
      }

      try {
        const result = await callback(selection, apiKey);
        markCredentialSuccess(this.config.namespace, selection.set, selection.item);
        return result;
      } catch (error) {
        lastError = this.handleCredentialFailure(selection, error);
      }
    }

    throw lastError ?? new Error(`No available MoEmail credentials for ${useCase}.`);
  }

  public async getConfig(): Promise<Record<string, unknown>> {
    return this.withCredential("poll", "probe", async (_selection, apiKey) => {
      const response = await requestJson(this.config, apiKey, "GET", "/api/config");
      if (response.status !== 200) {
        throw buildStatusError("getConfig", response.status, response.body);
      }
      return asRecord(response.body);
    });
  }

  public async createMailbox(options: {
    name?: string;
    expiryTime?: number;
    domain?: string;
  } = {}): Promise<MoemailMailboxCredentials> {
    return this.withCredential("generate", options.name, async (_selection, apiKey) => {
      const requestedIdentity = splitEmailAddress(options.name);
      const localPart = requestedIdentity?.localPart || createLocalPartSeed(options.name);
      let domain = requestedIdentity?.domain || options.domain?.trim() || this.config.preferredDomain;
      if (!domain) {
        const configResponse = await requestJson(this.config, apiKey, "GET", "/api/config");
        if (configResponse.status === 200) {
          const configDomains = extractDomainsFromConfig(asRecord(configResponse.body));
          if (configDomains.length > 0) {
            domain = configDomains[0];
          }
        }
      }
      try {
        return await this.generateMailboxWithApiKey(apiKey, {
          localPart,
          expiryTime: options.expiryTime,
          domain,
        });
      } catch (error) {
        const recovered = await this.recoverRequestedMailboxConflict(apiKey, error, {
          requestedEmail: requestedIdentity?.email,
          localPart,
          expiryTime: options.expiryTime,
          domain,
        });
        if (recovered) {
          return recovered;
        }
        throw error;
      }
    });
  }

  public async listEmails(
    cursor?: string,
    useCase: "generate" | "poll" = "poll",
  ): Promise<{ emails: MoemailMailboxListingEntry[]; nextCursor?: string; total?: number }> {
    return this.withCredential(
      useCase,
      cursor ? `list:${cursor}` : "list",
      async (_selection, apiKey) => this.listEmailsWithApiKey(apiKey, cursor),
    );
  }

  public async listMailboxMessages(
    emailId: string,
    cursor: string | undefined,
  ): Promise<{ items: MoemailMessageSummary[]; nextCursor?: string }> {
    return this.withCredential(
      "poll",
      emailId,
      async (_selection, apiKey) => this.listMailboxMessagesWithApiKey(apiKey, emailId, cursor),
    );
  }

  public async getMailboxMessage(
    emailId: string,
    messageId: string,
  ): Promise<Record<string, unknown>> {
    return this.withCredential("poll", `${emailId}:${messageId}`, async (_selection, apiKey) => {
      const response = await requestJson(
        this.config,
        apiKey,
        "GET",
        `/api/emails/${encodeURIComponent(emailId)}/${encodeURIComponent(messageId)}`,
      );

      if (response.status === 404) {
        return {};
      }
      if (response.status !== 200) {
        throw buildStatusError("getMailboxMessage", response.status, response.body);
      }

      return asRecord(response.body);
    });
  }

  public async deleteMailbox(
    emailId: string,
    useCase: "generate" | "poll" = "poll",
  ): Promise<{ released: boolean; detail: string }> {
    if (this.config.webSessionToken?.trim()) {
      return this.deleteMailboxViaWebSession(emailId);
    }

    return this.withCredential(useCase, emailId, async (_selection, apiKey) => {
      return this.deleteMailboxWithApiKey(apiKey, emailId, useCase);
    });
  }

  private async deleteMailboxViaWebSession(
    emailId: string,
  ): Promise<{ released: boolean; detail: string }> {
    const sessionToken = this.config.webSessionToken?.trim();
    if (!sessionToken) {
      throw new MoemailClientError("MoEmail web session token is missing.", "provider");
    }

    const origin = trimTrailingSlash(this.config.apiBase || "https://sall.cc");
    const cookieParts = [
      `__Secure-authjs.session-token=${sessionToken}`,
      this.config.webCsrfToken?.trim()
        ? `__Host-authjs.csrf-token=${this.config.webCsrfToken.trim()}`
        : undefined,
      this.config.webCallbackUrl?.trim()
        ? `__Secure-authjs.callback-url=${this.config.webCallbackUrl.trim()}`
        : undefined,
    ].filter((item): item is string => Boolean(item && item.trim()));

    const response = await fetch(`${origin}/api/emails/${encodeURIComponent(emailId)}`, {
      method: "DELETE",
      headers: {
        Accept: "*/*",
        Origin: origin,
        Referer: this.config.webReferer?.trim() || `${origin}/zh-CN/moe`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        Cookie: cookieParts.join("; "),
      },
    });

    const text = await response.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } else {
      body = {};
    }

    if (response.status === 404) {
      return {
        released: true,
        detail: "already_missing",
      };
    }
    if (response.status !== 200 && response.status !== 204) {
      throw buildStatusError("deleteMailboxWeb", response.status, body);
    }

    return {
      released: true,
      detail: "deleted",
    };
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: MoemailMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    let cursor: string | undefined;

    for (let page = 0; page < 3; page += 1) {
      const batch = await this.listMailboxMessages(mailbox.emailId, cursor);
      for (const item of batch.items) {
        if (!matchesSenderFilter(item.sender, fromContains)) {
          continue;
        }

        const summaryOtp = extractOtp({
          subject: item.subject,
          textBody: item.textBody,
          htmlBody: item.htmlBody,
        });
        if (summaryOtp) {
          return {
            id: `moemail:${item.messageId}`,
            sessionId,
            providerInstanceId,
            observedAt: item.observedAt,
            sender: item.sender,
            subject: item.subject,
            textBody: item.textBody,
            htmlBody: item.htmlBody,
            extractedCode: summaryOtp.code,
            codeSource: summaryOtp.source,
          };
        }

        const detail = await this.getMailboxMessage(mailbox.emailId, item.messageId);
        const sender = readMessageSender(detail) ?? item.sender;
        if (!matchesSenderFilter(sender, fromContains)) {
          continue;
        }
        const subject = readMessageSubject(detail) ?? item.subject;
        const textBody = readMessageText(detail) ?? item.textBody;
        const htmlBody = readMessageHtml(detail) ?? item.htmlBody;
        const detailOtp = extractOtp({
          subject,
          textBody,
          htmlBody,
        });
        return {
          id: `moemail:${item.messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: toIsoTimestamp(
            detail.received_at
            ?? detail.receivedAt
            ?? detail.sent_at
            ?? detail.createdAt
            ?? detail.created_at
            ?? detail.updatedAt
            ?? detail.updated_at
            ?? item.observedAt,
          ),
          sender,
          subject,
          textBody,
          htmlBody,
          extractedCode: detailOtp?.code,
          ...(detailOtp?.candidates ? { extractedCandidates: detailOtp.candidates } : {}),
          codeSource: detailOtp?.source,
        };
      }

      if (!batch.nextCursor?.trim()) {
        break;
      }
      cursor = batch.nextCursor;
    }

    return undefined;
  }
}

export function encodeMoemailMailboxRef(instanceId: string, mailbox: MoemailMailboxCredentials): string {
  return `moemail:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeMoemailMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): MoemailMailboxCredentials | undefined {
  const prefix = `moemail:${expectedInstanceId}:`;
  if (!mailboxRef.trim().startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(mailboxRef.slice(prefix.length))) as Record<string, unknown>;
    const emailId = readString(payload.emailId);
    const email = readString(payload.email)?.toLowerCase();
    if (!emailId || !email || !email.includes("@")) {
      return undefined;
    }
    return {
      emailId,
      email,
      localPart: readString(payload.localPart),
      domain: readString(payload.domain),
    };
  } catch {
    return undefined;
  }
}

function extractDomainsFromConfig(config: Record<string, unknown>): string[] {
  const roots = [config, asRecord(config.data), asRecord(config.result)];
  for (const root of roots) {
    const csvField = readString(root.emailDomains) ?? readString(root.email_domains);
    if (csvField) {
      const domains = csvField.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
      if (domains.length > 0) {
        return [...new Set(domains)];
      }
    }
    const objectList = asRecordList(root.domains);
    const domains = objectList.map((item) => readString(item.domain) ?? readString(item.name)).filter((item): item is string => Boolean(item));
    if (domains.length > 0) {
      return [...new Set(domains.map((item) => item.trim().toLowerCase()))];
    }
  }
  return [];
}

export async function probeMoemailInstance(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = MoemailClient.fromInstance(instance, credentialSets);
  if (!client) {
    return {
      ok: false,
      detail: "MoEmail instance is missing credentialSets/apiKey/keysFile configuration.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    const config = await client.getConfig();
    const domains = extractDomainsFromConfig(config);

    return {
      ok: true,
      detail: domains.length > 0
        ? `MOEMAIL_PROBE_OK: MoEmail returned ${domains.length} domains.`
        : "MOEMAIL_PROBE_OK: MoEmail config endpoint responded.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "moemail",
        ...(domains.length > 0 ? { domainsCsv: domains.join(",") } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "moemail",
        errorClass: classifyMoemailError(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}
