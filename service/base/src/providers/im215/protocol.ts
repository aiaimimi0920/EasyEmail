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
  parseCredentialSetsJson,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import type { ProviderInstance } from "../../domain/models.js";
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
const SHARED_DOMAIN_RESTRICTION_RE = /(shared domain.*restricted|not accepting new public addresses)/i;
const DOMAIN_ROTATION_OFFSETS = new Map<string, number>();

export function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

export function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

export function readString(value: unknown): string | undefined {
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

export function readSender(value: unknown): string | undefined {
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

export function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
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

export function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

export function encodeQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

export function createRandomSuffix(length: number): string {
  return randomBytes(Math.max(length * 2, 12)).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, length).toLowerCase();
}

export function normalizeDomain(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function isDisabledFlag(value: unknown): boolean {
  return value === false
    || (typeof value === "string" && ["disabled", "inactive", "offline", "false", "unavailable"].includes(value.trim().toLowerCase()));
}

export function isIm215DomainUsable(item: Record<string, unknown>): boolean {
  if (isDisabledFlag(item.active)
    || isDisabledFlag(item.enabled)
    || isDisabledFlag(item.isActive)
    || isDisabledFlag(item.available)
    || isDisabledFlag(item.status)
    || item.isPublic === false
    || item.isVerified === false
    || item.isMxValid === false) {
    return false;
  }

  const dnsRecords = asRecord(item.dnsRecords);
  return dnsRecords.receivingReady !== false && dnsRecords.mxValid !== false;
}

export function nextDomainRotationOffset(namespace: string, domainCount: number): number {
  if (domainCount <= 1) {
    return 0;
  }

  const current = DOMAIN_ROTATION_OFFSETS.get(namespace) ?? 0;
  DOMAIN_ROTATION_OFFSETS.set(namespace, (current + 1) % domainCount);
  return current % domainCount;
}

export function sanitizeLocalPart(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[^a-z]+/, "m");
  const base = normalized || `m${createRandomSuffix(8)}`;
  return base.slice(0, 48);
}

export function parseExactEmailAddress(value: string): { address: string; localPart: string; domain: string } {
  const address = value.trim().toLowerCase();
  const atIndex = address.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === address.length - 1) {
    throw new Im215ClientError(`Invalid 215.im email address for same-address recreation: ${value}`, "provider");
  }

  return {
    address,
    localPart: address.slice(0, atIndex),
    domain: address.slice(atIndex + 1),
  };
}

export function classifyIm215Error(message: string): "auth" | "capacity" | "transient" | "provider" {
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

export function isSharedDomainRestrictionMessage(message: string): boolean {
  return SHARED_DOMAIN_RESTRICTION_RE.test(message);
}

export class Im215ClientError extends Error {
  public constructor(
    message: string,
    public readonly kind: "auth" | "capacity" | "transient" | "provider",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "Im215ClientError";
  }
}

export function classifyThrownError(error: unknown): Im215ClientError {
  if (error instanceof Im215ClientError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Im215ClientError(message, classifyIm215Error(message));
}

export function buildIm215StatusError(phase: string, status: number, body: unknown): Im215ClientError {
  const detail = readString(asRecord(body).message)
    ?? readString(asRecord(body).error)
    ?? readString(asRecord(body).detail)
    ?? (typeof body === "string" ? body.trim() : undefined);
  const message = `215.im ${phase} failed with status ${status}.${detail ? ` ${detail}` : ""}`;
  return new Im215ClientError(message, classifyIm215Error(message), status);
}

export async function requestJson(
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

export function createInlineCredentialSet(apiKey: string | undefined): CredentialSetDefinition | undefined {
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

export function extractDomainCandidates(body: unknown): string[] {
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
        const domain = normalizeDomain(item);
        if (domain) {
          seen.add(domain);
        }
        continue;
      }
      const itemRecord = item as Record<string, unknown>;
      const domain = normalizeDomain(readString(itemRecord.domain)
        ?? readString(itemRecord.name)
        ?? readString(itemRecord.value)
        ?? readString(itemRecord.domainName));
      if (domain && isIm215DomainUsable(itemRecord)) {
        seen.add(domain);
      }
    }
  }

  return [...seen];
}

export function extractMailboxPayload(body: unknown): Im215MailboxRefPayload | undefined {
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

export function extractMessageList(body: unknown): Record<string, unknown>[] {
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

export function readMessageId(record: Record<string, unknown>): string | undefined {
  return readString(record.id)
    ?? readString(record.messageId)
    ?? readString(record.mailId)
    ?? readString(record.uuid)
    ?? readString(record._id);
}

export function readObservedAt(record: Record<string, unknown>): string | undefined {
  return readString(record.createdAt)
    ?? readString(record.created_at)
    ?? readString(record.receivedAt)
    ?? readString(record.received_at)
    ?? readString(record.date)
    ?? readString(record.time);
}

export function readMessageSubject(record: Record<string, unknown>): string | undefined {
  return readString(record.subject) ?? readString(record.title);
}

export function readMessageSender(record: Record<string, unknown>): string | undefined {
  return readSender(record.from)
    ?? readSender(record.sender)
    ?? readString(record.from_address)
    ?? readString(record.mailFrom);
}

export function readMessageText(record: Record<string, unknown>): string | undefined {
  return readString(record.text)
    ?? readString(record.textBody)
    ?? readString(record.body)
    ?? readString(record.content)
    ?? readString(record.snippet)
    ?? readString(record.preview)
    ?? readString(record.intro);
}

export function readMessageHtml(record: Record<string, unknown>): string | undefined {
  return readString(record.html)
    ?? readString(record.htmlBody)
    ?? readString(record.html_content)
    ?? readString(record.raw_content);
}
