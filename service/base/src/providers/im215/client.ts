declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

import { randomBytes } from "node:crypto";
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

export interface Im215Config {
  instanceId: string;
  namespace: string;
  apiBase: string;
  credentialSets: CredentialSetDefinition[];
  preferredDomain?: string;
  autoDomainStrategy?: string;
  timeoutSeconds: number;
}

export interface Im215MailboxRefPayload {
  address: string;
  mailboxId?: string;
  domain?: string;
  createdAt?: string;
  tempToken?: string;
}

interface Im215RequestOptions {
  query?: Record<string, string | number | undefined>;
  jsonBody?: Record<string, unknown>;
}

const AUTH_ERROR_RE = /(status 401|status 403|unauthorized|forbidden|invalid api key|invalid token|missing api key|bearer|permission)/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|capacity|insufficient balance)/i;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2}|temporarily unavailable|gateway)/i;

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

function readString(value: unknown): string | undefined {
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

function readSender(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (value && typeof value === "object" && Array.isArray(value) === false) {
    const record = value as Record<string, unknown>;
    return readString(record.address)
      ?? readString(record.email)
      ?? readString(record.name)
      ?? readString(record.username)
      ?? readString(record.mail);
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
  const normalizedSender = sender?.trim().toLowerCase();
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

function createRandomSuffix(length: number): string {
  return randomBytes(Math.max(length * 2, 12)).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, length).toLowerCase();
}

function sanitizeLocalPart(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[^a-z]+/, "m");
  const base = normalized || `m${createRandomSuffix(8)}`;
  return base.slice(0, 48);
}

function classifyIm215Error(message: string): "auth" | "capacity" | "transient" | "provider" {
  const normalized = message.trim().toLowerCase();
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

class Im215ClientError extends Error {
  public constructor(
    message: string,
    public readonly kind: "auth" | "capacity" | "transient" | "provider",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "Im215ClientError";
  }
}

function classifyThrownError(error: unknown): Im215ClientError {
  if (error instanceof Im215ClientError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Im215ClientError(message, classifyIm215Error(message));
}

function buildIm215StatusError(phase: string, status: number, body: unknown): Im215ClientError {
  const detail = readString(asRecord(body).message)
    ?? readString(asRecord(body).error)
    ?? readString(asRecord(body).detail)
    ?? (typeof body === "string" ? body.trim() : undefined);
  const message = `215.im ${phase} failed with status ${status}.${detail ? ` ${detail}` : ""}`;
  return new Im215ClientError(message, classifyIm215Error(message), status);
}

async function requestJson(
  config: Im215Config,
  apiKey: string,
  method: string,
  path: string,
  options: Im215RequestOptions = {},
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(5, config.timeoutSeconds) * 1000);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (options.jsonBody) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetch(`${config.apiBase.replace(/\/$/, "")}${path}${encodeQuery(options.query ?? {})}`, {
      method,
      headers,
      body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
      signal: controller.signal,
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
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("abort")) {
      throw new Im215ClientError(`215.im request to ${path} timed out after ${config.timeoutSeconds}s.`, "transient");
    }
    throw classifyThrownError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function createInlineCredentialSet(apiKey: string | undefined): CredentialSetDefinition | undefined {
  if (!apiKey?.trim()) {
    return undefined;
  }
  return {
    id: "inline-default",
    displayName: "Inline 215.im API Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    items: [{ id: "inline-key", label: "Inline Key", value: apiKey.trim(), metadata: {} }],
    metadata: {},
  };
}

export function resolveIm215CredentialSets(instance: ProviderInstance): CredentialSetDefinition[] {
  const configured = parseCredentialSetsJson(readMetadata(instance, "credentialSetsJson"));
  if (configured.length > 0) {
    return configured;
  }

  const inlineSet = createInlineCredentialSet(readMetadata(instance, "apiKey"));
  const fileSet = createValueCredentialSetFromFile(readMetadata(instance, "keysFile"), {
    id: "keys-file",
    displayName: "215.im Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  return [inlineSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);
}

export function resolveIm215Config(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Im215Config {
  return {
    instanceId: instance.id,
    namespace: `mail:im215:${instance.id}`,
    apiBase: readMetadata(instance, "apiBase") ?? "https://maliapi.215.im/v1",
    credentialSets: credentialSets && credentialSets.length > 0
      ? credentialSets
      : resolveIm215CredentialSets(instance),
    preferredDomain: readMetadata(instance, "domain"),
    autoDomainStrategy: readMetadata(instance, "autoDomainStrategy"),
    timeoutSeconds: parseOptionalInteger(readMetadata(instance, "timeoutSeconds")) ?? 20,
  };
}

function extractDomainCandidates(body: unknown): string[] {
  const record = asRecord(body);
  const sources = [
    body,
    record.data,
    record.items,
    record.domains,
    record.list,
    asRecord(record.data).items,
    asRecord(record.data).domains,
    asRecord(record.result).items,
    asRecord(record.result).domains,
  ];

  const seen = new Set<string>();
  for (const source of sources) {
    const items = Array.isArray(source)
      ? source
      : asRecordList(source);
    for (const item of items) {
      if (typeof item === "string") {
        const domain = item.trim().toLowerCase();
        if (domain) {
          seen.add(domain);
        }
        continue;
      }
      const domain = readString((item as Record<string, unknown>).domain)
        ?? readString((item as Record<string, unknown>).name)
        ?? readString((item as Record<string, unknown>).value)
        ?? readString((item as Record<string, unknown>).domainName);
      const active = (item as Record<string, unknown>).active
        ?? (item as Record<string, unknown>).enabled
        ?? (item as Record<string, unknown>).isActive
        ?? (item as Record<string, unknown>).available
        ?? (item as Record<string, unknown>).status;
      const isInactive = active === false
        || (typeof active === "string" && ["disabled", "inactive", "offline"].includes(active.trim().toLowerCase()));
      if (domain && !isInactive) {
        seen.add(domain.trim().toLowerCase());
      }
    }
  }

  return [...seen];
}

function extractMailboxPayload(body: unknown): Im215MailboxRefPayload | undefined {
  const record = asRecord(body);
  const nested = [
    record,
    asRecord(record.data),
    asRecord(record.account),
    asRecord(record.mailbox),
    asRecord(record.result),
    asRecord(asRecord(record.data).account),
    asRecord(asRecord(record.data).mailbox),
  ];

  for (const candidate of nested) {
    const address = readString(candidate.address)
      ?? readString(candidate.email)
      ?? readString(candidate.mailbox)
      ?? readString(candidate.username);
    if (!address || !address.includes("@")) {
      continue;
    }
    return {
      address: address.trim().toLowerCase(),
      mailboxId: readString(candidate.id) ?? readString(candidate.accountId) ?? readString(candidate.mailboxId),
      domain: readString(candidate.domain),
      createdAt: readString(candidate.createdAt) ?? readString(candidate.created_at),
      tempToken: readString(candidate.token) ?? readString(candidate.tempToken),
    };
  }

  return undefined;
}

function extractMessageList(body: unknown): Record<string, unknown>[] {
  const record = asRecord(body);
  const sources = [
    body,
    record.data,
    record.items,
    record.messages,
    record.list,
    asRecord(record.data).items,
    asRecord(record.data).messages,
    asRecord(record.result).items,
    asRecord(record.result).messages,
  ];

  for (const source of sources) {
    const items = Array.isArray(source) ? asRecordList(source) : asRecordList(source);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

function readMessageId(record: Record<string, unknown>): string | undefined {
  return readString(record.id)
    ?? readString(record.messageId)
    ?? readString(record.mailId)
    ?? readString(record.uuid)
    ?? readString(record._id);
}

function readObservedAt(record: Record<string, unknown>): string | undefined {
  return readString(record.createdAt)
    ?? readString(record.created_at)
    ?? readString(record.receivedAt)
    ?? readString(record.received_at)
    ?? readString(record.date)
    ?? readString(record.time);
}

function readMessageSubject(record: Record<string, unknown>): string | undefined {
  return readString(record.subject) ?? readString(record.title);
}

function readMessageSender(record: Record<string, unknown>): string | undefined {
  return readSender(record.from)
    ?? readSender(record.sender)
    ?? readString(record.from_address)
    ?? readString(record.mailFrom);
}

function readMessageText(record: Record<string, unknown>): string | undefined {
  return readString(record.text)
    ?? readString(record.textBody)
    ?? readString(record.body)
    ?? readString(record.content)
    ?? readString(record.snippet)
    ?? readString(record.preview)
    ?? readString(record.intro);
}

function readMessageHtml(record: Record<string, unknown>): string | undefined {
  return readString(record.html)
    ?? readString(record.htmlBody)
    ?? readString(record.html_content)
    ?? readString(record.raw_content);
}

export class Im215Client {
  public constructor(private readonly config: Im215Config) {}

  public static fromInstance(
    instance: ProviderInstance,
    credentialSets?: CredentialSetDefinition[],
  ): Im215Client | undefined {
    const config = resolveIm215Config(instance, credentialSets);
    if (config.credentialSets.length === 0) {
      return undefined;
    }

    return new Im215Client(config);
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

  private handleCredentialFailure(selection: CredentialSelection, error: unknown): Im215ClientError {
    const classified = classifyThrownError(error);
    if (classified.kind === "auth") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        error: classified.message,
      });
      return classified;
    }
    if (classified.kind === "capacity") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "rate-limited",
        error: classified.message,
      });
      return classified;
    }

    if (classified.kind === "provider") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        error: classified.message,
      });
      return classified;
    }

    markCredentialFailure(this.config.namespace, selection.set, selection.item, {
      status: "cooling",
      cooldownMs: classified.kind === "transient" ? 30_000 : 60_000,
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
          new Im215ClientError("Selected 215.im credential is missing key value.", "auth"),
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

    throw lastError ?? new Error(`No available 215.im credentials for ${useCase}.`);
  }

  public async getDomains(): Promise<string[]> {
    return this.withCredential("poll", "probe", async (_selection, apiKey) => {
      const response = await requestJson(this.config, apiKey, "GET", "/domains");
      if (response.status !== 200) {
        throw buildIm215StatusError("getDomains", response.status, response.body);
      }

      const domains = extractDomainCandidates(response.body);
      return this.config.preferredDomain && domains.includes(this.config.preferredDomain)
        ? [this.config.preferredDomain, ...domains.filter((item) => item !== this.config.preferredDomain)]
        : domains;
    });
  }

  public async createMailbox(options: { suggestedLocalPart?: string; preferredDomain?: string; maxRetries?: number } = {}): Promise<Im215MailboxRefPayload> {
    const domains = await this.getDomains();
    if (domains.length === 0) {
      throw new Im215ClientError("215.im returned no available domains.", "provider");
    }

    const maxRetries = options.maxRetries ?? 5;
    const baseLocalPart = sanitizeLocalPart(options.suggestedLocalPart);

    return this.withCredential("generate", baseLocalPart, async (_selection, apiKey) => {
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const preferredDomain = options.preferredDomain?.trim() || this.config.preferredDomain;
        const domain = preferredDomain && domains.includes(preferredDomain)
          ? preferredDomain
          : domains[attempt % domains.length]!;
        const localPart = `${baseLocalPart}-${createRandomSuffix(4)}`.slice(0, 60);
        const address = `${localPart}@${domain}`;
        const payloads: Record<string, unknown>[] = [
          {
            prefix: localPart,
            ...(domain ? { domain } : {}),
            ...(this.config.autoDomainStrategy ? { autoDomainStrategy: this.config.autoDomainStrategy } : {}),
          },
          {
            address,
            ...(this.config.autoDomainStrategy ? { autoDomainStrategy: this.config.autoDomainStrategy } : {}),
          },
        ];

        for (const payload of payloads) {
          const response = await requestJson(this.config, apiKey, "POST", "/accounts", {
            jsonBody: payload,
          });

          if (response.status === 200 || response.status === 201) {
            return extractMailboxPayload(response.body) ?? {
              address,
              domain,
            };
          }

          if ([400, 409, 422].includes(response.status)) {
            continue;
          }

          throw buildIm215StatusError("createMailbox", response.status, response.body);
        }
      }

      throw new Im215ClientError("215.im mailbox creation exhausted retries.", "capacity");
    });
  }

  public async listMessages(address: string): Promise<Record<string, unknown>[]> {
    return this.withCredential("poll", address, async (_selection, apiKey) => {
      const response = await requestJson(this.config, apiKey, "GET", "/messages", {
        query: { address },
      });
      if (response.status === 404) {
        return [];
      }
      if (response.status !== 200) {
        throw buildIm215StatusError("listMessages", response.status, response.body);
      }
      return extractMessageList(response.body);
    });
  }

  public async getMessage(messageId: string): Promise<Record<string, unknown>> {
    return this.withCredential("poll", messageId, async (_selection, apiKey) => {
      const response = await requestJson(this.config, apiKey, "GET", `/messages/${encodeURIComponent(messageId)}`);
      if (response.status === 404) {
        return {};
      }
      if (response.status !== 200) {
        throw buildIm215StatusError("getMessage", response.status, response.body);
      }
      return asRecord(response.body);
    });
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: Im215MailboxRefPayload,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.listMessages(mailbox.address);

    for (const item of messages) {
      const sender = readMessageSender(item);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const messageId = readMessageId(item);
      const subject = readMessageSubject(item);
      const textBody = readMessageText(item);
      const htmlBody = readMessageHtml(item);
      const observedAt = readObservedAt(item) ?? "";

      const summaryOtp = extractOtp({
        subject,
        textBody,
        htmlBody,
      });
      if (summaryOtp) {
        return {
          id: `im215:${messageId ?? summaryOtp.code}`,
          sessionId,
          providerInstanceId,
          observedAt,
          sender,
          subject,
          textBody,
          htmlBody,
          extractedCode: summaryOtp.code,
          codeSource: summaryOtp.source,
        };
      }

      if (!messageId) {
        if (subject || textBody || htmlBody) {
          return {
            id: `im215:${observedAt || sessionId}`,
            sessionId,
            providerInstanceId,
            observedAt,
            sender,
            subject,
            textBody,
            htmlBody,
          };
        }
        continue;
      }

      const detail = await this.getMessage(messageId);
      const detailSender = readMessageSender(detail) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContains)) {
        continue;
      }
      const detailSubject = readMessageSubject(detail) ?? subject;
      const detailText = readMessageText(detail) ?? textBody;
      const detailHtml = readMessageHtml(detail) ?? htmlBody;
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody: detailText,
        htmlBody: detailHtml,
      });
      return {
        id: `im215:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: readObservedAt(detail) ?? observedAt,
        sender: detailSender,
        subject: detailSubject,
        textBody: detailText,
        htmlBody: detailHtml,
        extractedCode: detailOtp?.code,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export function encodeIm215MailboxRef(instanceId: string, mailbox: Im215MailboxRefPayload): string {
  return `im215:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeIm215MailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): Im215MailboxRefPayload | undefined {
  const prefix = `im215:${expectedInstanceId}:`;
  if (!mailboxRef.trim().startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(mailboxRef.slice(prefix.length))) as Record<string, unknown>;
    const address = readString(payload.address)?.toLowerCase();
    if (!address || !address.includes("@")) {
      return undefined;
    }
    return {
      address,
      mailboxId: readString(payload.mailboxId),
      domain: readString(payload.domain),
      createdAt: readString(payload.createdAt),
      tempToken: readString(payload.tempToken),
    };
  } catch {
    return undefined;
  }
}

export async function probeIm215Instance(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = Im215Client.fromInstance(instance, credentialSets);
  if (!client) {
    return {
      ok: false,
      detail: "215.im instance is missing credentialSets/apiKey/keysFile configuration.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? `IM215_PROBE_OK: 215.im returned ${domains.length} available domains.`
        : "IM215_MAILBOX_DELIVERY_FAILURE: 215.im returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "im215",
        state: domains.length > 0 ? "ok" : "empty-domain-list",
      },
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "im215",
        errorClass: classifyIm215Error(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}
