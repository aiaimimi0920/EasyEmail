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

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createBasicAuthCredentialSetFromFile,
  createBasicAuthCredentialSetFromLines,
  markCredentialCriticalFailure,
  markCredentialFailure,
  markCredentialSuccess,
  parseCredentialSetsJson,
  selectCredentialItem,
  type CredentialSelection,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import { extractOtpFromContent } from "../../domain/otp.js";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";

export interface Mail2925Config {
  instanceId: string;
  namespace: string;
  apiBase: string;
  credentialSets: CredentialSetDefinition[];
  domain: string;
  folderName: string;
  aliasSeparator: string;
  aliasSuffixLength: number;
  timeoutSeconds: number;
  jwtToken?: string;
  deviceUid?: string;
  cookieHeader?: string;
}

export interface Mail2925MailboxRefPayload {
  aliasAddress: string;
  accountEmail: string;
  folderName?: string;
  credentialSetId?: string;
  credentialItemId?: string;
  createdAt?: string;
}

interface Mail2925RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  formBody?: Record<string, string | number | boolean | undefined>;
  token?: string;
  extraHeaders?: Record<string, string>;
}

interface Mail2925AccountCredential {
  selection: CredentialSelection;
  username: string;
  password: string;
  accountEmail: string;
  localPart: string;
  domain: string;
}

interface Mail2925TokenCacheEntry {
  token: string;
  expiresAtMs: number;
}

const LOGIN_CACHE_TTL_MS = 10 * 60_000;
const loginTokenCache = new Map<string, Mail2925TokenCacheEntry>();
const AUTH_ERROR_RE = /(status 401|status 403|unauthorized|forbidden|invalid password|password error|login failed|token|登录|密码|认证)/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota)/i;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2}|temporarily unavailable|gateway)/i;
const MAIL2925_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const PYTHON_MAIL2925_REQUEST_SCRIPT = [
  "import json, sys",
  "import requests",
  "payload = json.loads(sys.argv[1])",
  "response = requests.request(payload['method'], payload['url'], headers=payload.get('headers') or {}, params=payload.get('params') or {}, timeout=payload.get('timeout', 60))",
  "text = response.text or ''",
  "try:",
  "    body = json.loads(text) if text else {}",
  "except Exception:",
  "    body = text",
  "print(json.dumps({'status': response.status_code, 'body': body}, ensure_ascii=False))",
].join("\n");

class Mail2925ClientError extends Error {
  public constructor(
    message: string,
    public readonly kind: "auth" | "capacity" | "transient" | "provider",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "Mail2925ClientError";
  }
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
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return undefined;
}

function readEnvelopeCode(body: unknown): number | undefined {
  const code = asRecord(body).code;
  if (typeof code === "number" && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === "string" && code.trim()) {
    const parsed = Number.parseInt(code, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readEnvelopeResult(body: unknown): unknown {
  const record = asRecord(body);
  return record.result ?? record.data ?? body;
}

function readEnvelopeMessage(body: unknown): string | undefined {
  const record = asRecord(body);
  return readString(record.message)
    ?? readString(record.error)
    ?? readString(record.detail)
    ?? readString(asRecord(record.result).message);
}

function isSuccessfulEnvelope(status: number, body: unknown): boolean {
  if (status >= 400) {
    return false;
  }

  const code = readEnvelopeCode(body);
  if (code === undefined) {
    return true;
  }

  return code === 0 || code === 200;
}

function classifyMail2925Error(message: string): "auth" | "capacity" | "transient" | "provider" {
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

function classifyThrownError(error: unknown): Mail2925ClientError {
  if (error instanceof Mail2925ClientError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Mail2925ClientError(message, classifyMail2925Error(message));
}

function buildMail2925StatusError(phase: string, status: number, body: unknown): Mail2925ClientError {
  const code = readEnvelopeCode(body);
  const detail = readEnvelopeMessage(body)
    ?? (typeof body === "string" ? body.trim() : undefined);
  const message = `2925 ${phase} failed with status ${status}${code !== undefined ? ` code ${code}` : ""}.${detail ? ` ${detail}` : ""}`;
  return new Mail2925ClientError(message, classifyMail2925Error(message), status);
}

function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function encodeFormBody(body: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}

async function requestJson(
  config: Mail2925Config,
  method: string,
  path: string,
  options: Mail2925RequestOptions = {},
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(5, config.timeoutSeconds) * 1000);

  try {
    const response = await fetch(
      `${config.apiBase.replace(/\/$/, "")}${path}${encodeQuery(options.query ?? {})}`,
      {
        method,
        headers: {
          Accept: "application/json, text/plain, */*",
          ...(options.formBody ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(config.deviceUid ? { deviceUid: config.deviceUid } : {}),
          ...(config.cookieHeader ? { Cookie: config.cookieHeader } : {}),
          ...(options.extraHeaders ?? {}),
        },
        body: options.formBody ? encodeFormBody(options.formBody) : undefined,
        signal: controller.signal,
      },
    );

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
      throw new Mail2925ClientError(`2925 request to ${path} timed out after ${config.timeoutSeconds}s.`, "transient");
    }
    throw classifyThrownError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function requestJsonWithPython(
  method: string,
  url: string,
  headers: Record<string, string>,
  query: Record<string, string | number | boolean | undefined>,
  timeoutSeconds: number,
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify({
    method,
    url,
    headers,
    params: Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined),
    ),
    timeout: Math.max(5, timeoutSeconds),
  });

  const commandCandidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  let lastError: Error | undefined;

  for (const command of commandCandidates) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          command,
          ["-c", PYTHON_MAIL2925_REQUEST_SCRIPT, payload],
          {
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error) {
              const detail = stderr?.trim() || stdout?.trim() || error.message;
              reject(new Error(detail));
              return;
            }
            resolve(stdout);
          },
        );
      });

      const normalized = output.trim();
      if (!normalized) {
        return { status: 0, body: {} };
      }
      return JSON.parse(normalized) as { status: number; body: unknown };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const normalizedMessage = lastError.message.toLowerCase();
      if (normalizedMessage.includes("not found") || normalizedMessage.includes("cannot find")) {
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("Python runtime is unavailable for 2925 message fallback.");
}

function normalizeAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function matchesAliasRecipient(
  recipients: string[],
  aliasAddress: string,
  accountEmail: string,
): boolean {
  const normalizedAccount = normalizeAddress(accountEmail);
  for (const recipient of recipients) {
    if (recipient === aliasAddress) {
      return true;
    }
    if (normalizedAccount && recipient === normalizedAccount) {
      return true;
    }
  }
  return false;
}

function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const normalizedFilter = normalizeFilter(fromContains);
  if (!normalizedFilter) {
    return true;
  }
  const normalizedSender = normalizeAddress(sender);
  if (!normalizedSender) {
    return false;
  }
  return normalizedSender.includes(normalizedFilter);
}

function readAddress(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    const match = normalized.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return normalizeAddress(match?.[0] ?? normalized);
  }

  if (value && typeof value === "object" && Array.isArray(value) === false) {
    const record = value as Record<string, unknown>;
    return normalizeAddress(
      readString(record.emailAddress)
      ?? readString(record.address)
      ?? readString(record.mailAddress)
      ?? readString(record.email)
      ?? readString(record.mail)
      ?? readString(record.sender)
      ?? readString(record.senderAddress),
    );
  }

  return undefined;
}

function readAddressList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => readAddress(item))
      .filter((item): item is string => Boolean(item));
  }

  const single = readAddress(value);
  if (!single) {
    return [];
  }

  return [single];
}

function readRecipients(record: Record<string, unknown>): string[] {
  const recipients = [
    record.mailTo,
    record.to,
    record.toAddress,
    record.mailReceivers,
    record.receivers,
    record.mailAddress,
  ].flatMap((value) => readAddressList(value));

  return [...new Set(recipients)];
}

function readSender(record: Record<string, unknown>): string | undefined {
  return readAddress(record.mailFrom)
    ?? readAddress(record.from)
    ?? readAddress(record.sender)
    ?? normalizeAddress(readString(record.fromAddress))
    ?? normalizeAddress(readString(record.mailFromAddress));
}

function readMessageId(record: Record<string, unknown>): string | undefined {
  return readString(record.MessageID)
    ?? readString(record.messageID)
    ?? readString(record.messageId)
    ?? readString(record.id)
    ?? readString(record.mailId);
}

function readMessageTimestampMs(record: Record<string, unknown>): number {
  const raw = record.createTime ?? record.modifyDate ?? record.ReceiveTime ?? record.receiveTime;
  if (typeof raw === "number" && raw > 0) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed > 1e12 ? parsed : parsed * 1000;
    }
  }
  return 0;
}

function readObservedAt(record: Record<string, unknown>): string | undefined {
  const direct = readString(record.ReceiveTime)
    ?? readString(record.receiveTime)
    ?? readString(record.receivedAt)
    ?? readString(record.received_at)
    ?? readString(record.SendDate)
    ?? readString(record.date);
  if (direct) {
    return direct;
  }

  // 2925 API uses createTime/modifyDate as epoch-millisecond timestamps.
  const epochMs = readMessageTimestampMs(record);
  if (epochMs > 0) {
    return new Date(epochMs).toISOString();
  }

  return undefined;
}

function readMessageSubject(record: Record<string, unknown>): string | undefined {
  return readString(record.mailSubject)
    ?? readString(record.subject)
    ?? readString(record.title);
}

function readMessageText(record: Record<string, unknown>): string | undefined {
  const raw = record.bodyText ?? record.textBody ?? record.bodyContent ?? record.text ?? record.content;
  if (Array.isArray(raw)) {
    const joined = raw.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }
  return readString(raw);
}

function readMessageHtml(record: Record<string, unknown>): string | undefined {
  const raw = record.bodyHtmlText ?? record.htmlBody ?? record.html ?? record.rawContent;
  if (Array.isArray(raw)) {
    const joined = raw.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }
  return readString(raw);
}

function extractMessageList(body: unknown): Record<string, unknown>[] {
  const envelopeResult = readEnvelopeResult(body);
  const directItems = asRecordList(envelopeResult);
  if (directItems.length > 0) {
    return directItems;
  }

  const result = asRecord(envelopeResult);
  const sources = [
    result.rows,
    result.list,
    result.items,
    result.mails,
    result.data,
    asRecord(result.data).rows,
    asRecord(result.data).list,
    asRecord(result.data).items,
  ];

  for (const source of sources) {
    const items = asRecordList(source);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

function extractFolderNames(body: unknown): string[] {
  const envelopeResult = readEnvelopeResult(body);
  const directItems = asRecordList(envelopeResult);
  if (directItems.length > 0) {
    return directItems
      .map((item) => readString(item.name) ?? readString(item.folderName) ?? readString(item.FolderName))
      .filter((item): item is string => Boolean(item));
  }

  const result = asRecord(envelopeResult);
  const sources = [result.rows, result.items, result.list, result.data];
  for (const source of sources) {
    const items = asRecordList(source);
    if (items.length === 0) {
      continue;
    }
    const names = items
      .map((item) => readString(item.name) ?? readString(item.folderName) ?? readString(item.FolderName))
      .filter((item): item is string => Boolean(item));
    if (names.length > 0) {
      return names;
    }
  }

  return [];
}

function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

function sanitizeAliasFragment(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized || randomBytes(6).toString("hex").slice(0, 10);
}

function sanitizeAliasSeparator(value: string | undefined): string {
  const normalized = (value ?? "_").trim();
  return /^[._-]{0,3}$/.test(normalized) ? normalized : "_";
}

function normalizeAccountAddress(value: string, fallbackDomain: string): {
  username: string;
  accountEmail: string;
  localPart: string;
  domain: string;
} {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Mail2925ClientError("2925 credential username is empty.", "auth");
  }

  if (normalized.includes("@")) {
    const [localPartRaw, domainRaw] = normalized.split("@", 2);
    const localPart = localPartRaw.trim();
    const domain = domainRaw.trim() || fallbackDomain;
    if (!localPart || !domain) {
      throw new Mail2925ClientError(`2925 credential username "${value}" is invalid.`, "auth");
    }
    return {
      username: normalized,
      accountEmail: `${localPart}@${domain}`,
      localPart,
      domain,
    };
  }

  return {
    username: normalized,
    accountEmail: `${normalized}@${fallbackDomain}`,
    localPart: normalized,
    domain: fallbackDomain,
  };
}

function buildAliasAddress(
  account: Mail2925AccountCredential,
  sessionHint: string,
  aliasSeparator: string,
  aliasSuffixLength: number,
  requestedDomain: string | undefined,
): string {
  const requested = normalizeAddress(requestedDomain);
  if (requested && requested !== account.domain) {
    throw new Mail2925ClientError(
      `2925 only supports aliases on ${account.domain}; requested ${requested}.`,
      "provider",
    );
  }

  const suffix = sanitizeAliasFragment(sessionHint).slice(0, Math.max(4, aliasSuffixLength));
  const separator = sanitizeAliasSeparator(aliasSeparator);
  const room = Math.max(1, 64 - account.localPart.length - separator.length);
  const localPart = `${account.localPart}${separator}${suffix.slice(0, room)}`;
  return `${localPart}@${account.domain}`;
}

function createInlineCredentialSet(account: string | undefined, password: string | undefined): CredentialSetDefinition | undefined {
  if (!account?.trim() || !password?.trim()) {
    return undefined;
  }

  return {
    id: "inline-default",
    displayName: "Inline 2925 Credentials",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    items: [{
      id: "inline-account",
      label: account.trim(),
      username: account.trim(),
      password: password.trim(),
      metadata: {},
    }],
    metadata: {},
  };
}

function buildLoginCacheKey(namespace: string, selection: CredentialSelection): string {
  return `${namespace}::${selection.set.id}::${selection.item.id}`;
}

export function resolveMail2925CredentialSets(instance: ProviderInstance): CredentialSetDefinition[] {
  const configured = parseCredentialSetsJson(readMetadata(instance, "credentialSetsJson"));
  if (configured.length > 0) {
    return configured;
  }

  const inlineSet = createInlineCredentialSet(
    readMetadata(instance, "account") ?? readMetadata(instance, "username"),
    readMetadata(instance, "password"),
  );
  const textSet = createBasicAuthCredentialSetFromLines(readMetadata(instance, "accountsText"), {
    id: "accounts-lines",
    displayName: "2925 Credentials",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 90,
  });
  const fileSet = createBasicAuthCredentialSetFromFile(readMetadata(instance, "accountsFile"), {
    id: "accounts-file",
    displayName: "2925 Credentials File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  return [inlineSet, textSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);
}

export function resolveMail2925Config(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Mail2925Config {
  return {
    instanceId: instance.id,
    namespace: `mail:mail2925:${instance.id}`,
    apiBase: readMetadata(instance, "apiBase") ?? "https://mail.2925.com",
    credentialSets: credentialSets && credentialSets.length > 0
      ? credentialSets
      : resolveMail2925CredentialSets(instance),
    domain: readMetadata(instance, "domain") ?? "2925.com",
    folderName: readMetadata(instance, "folderName") ?? "Inbox",
    aliasSeparator: sanitizeAliasSeparator(readMetadata(instance, "aliasSeparator")),
    aliasSuffixLength: parseOptionalInteger(readMetadata(instance, "aliasSuffixLength")) ?? 10,
    timeoutSeconds: parseOptionalInteger(readMetadata(instance, "timeoutSeconds")) ?? 20,
    jwtToken: readMetadata(instance, "jwtToken") ?? readMetadata(instance, "webJwtToken"),
    deviceUid: readMetadata(instance, "deviceUid"),
    cookieHeader: readMetadata(instance, "cookieHeader"),
  };
}

export class Mail2925Client {
  public constructor(private readonly config: Mail2925Config) {}

  private canRefreshConfiguredSessionToken(): boolean {
    return Boolean(this.config.cookieHeader?.trim() && this.config.deviceUid?.trim());
  }

  public static fromInstance(
    instance: ProviderInstance,
    credentialSets?: CredentialSetDefinition[],
  ): Mail2925Client | undefined {
    const config = resolveMail2925Config(instance, credentialSets);
    if (config.credentialSets.length === 0) {
      return undefined;
    }

    return new Mail2925Client(config);
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

  private resolveAccountCredential(selection: CredentialSelection): Mail2925AccountCredential {
    const username = selection.item.username?.trim();
    const password = selection.item.password?.trim();
    if (!username || !password) {
      throw new Mail2925ClientError("Selected 2925 credential is missing username/password.", "auth");
    }

    const normalized = normalizeAccountAddress(username, this.config.domain);
    return {
      selection,
      username: normalized.username,
      password,
      accountEmail: normalized.accountEmail,
      localPart: normalized.localPart,
      domain: normalized.domain,
    };
  }

  public resolveBoundCredential(mailbox: Mail2925MailboxRefPayload): Mail2925AccountCredential | undefined {
    for (const set of this.config.credentialSets) {
      if (set.useCases.includes("poll") === false && set.useCases.includes("generate") === false) {
        continue;
      }
      for (const item of set.items) {
        const matchesById = mailbox.credentialSetId === set.id && mailbox.credentialItemId === item.id;
        const normalized = item.username ? normalizeAccountAddress(item.username, this.config.domain) : undefined;
        const matchesByAccount = normalized?.accountEmail === normalizeAddress(mailbox.accountEmail);
        if (!matchesById && !matchesByAccount) {
          continue;
        }
        return this.resolveAccountCredential({ set, item });
      }
    }

    return undefined;
  }

  private handleCredentialFailure(selection: CredentialSelection, error: unknown): Mail2925ClientError {
    const classified = classifyThrownError(error);
    loginTokenCache.delete(buildLoginCacheKey(this.config.namespace, selection));

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
      cooldownMs: 5_000,
      error: classified.message,
    });
    return classified;
  }

  private async withCredential<T>(
    useCase: "generate" | "poll",
    stickyKey: string | undefined,
    callback: (account: Mail2925AccountCredential) => Promise<T>,
  ): Promise<T> {
    const attempts = Math.max(1, this.countCandidateItems(useCase));
    let lastError: Error | undefined;

    for (let index = 0; index < attempts; index += 1) {
      const selection = this.select(useCase, stickyKey);
      if (!selection) {
        break;
      }

      let account: Mail2925AccountCredential;
      try {
        account = this.resolveAccountCredential(selection);
      } catch (error) {
        lastError = this.handleCredentialFailure(selection, error);
        continue;
      }

      try {
        const result = await callback(account);
        markCredentialSuccess(this.config.namespace, selection.set, selection.item);
        return result;
      } catch (error) {
        lastError = this.handleCredentialFailure(selection, error);
      }
    }

    throw lastError ?? new Mail2925ClientError(`No available 2925 credentials for ${useCase}.`, "auth");
  }

  private async withBoundCredential<T>(
    mailbox: Mail2925MailboxRefPayload,
    callback: (account: Mail2925AccountCredential) => Promise<T>,
  ): Promise<T> {
    const account = this.resolveBoundCredential(mailbox);
    if (!account) {
      throw new Mail2925ClientError(
        `2925 credential binding is missing for ${mailbox.accountEmail}.`,
        "auth",
      );
    }

    try {
      const result = await callback(account);
      markCredentialSuccess(this.config.namespace, account.selection.set, account.selection.item);
      return result;
    } catch (error) {
      throw this.handleCredentialFailure(account.selection, error);
    }
  }

  private async login(account: Mail2925AccountCredential, forceRefresh = false): Promise<string> {
    const cacheKey = buildLoginCacheKey(this.config.namespace, account.selection);
    const cached = loginTokenCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAtMs > Date.now()) {
      return cached.token;
    }

    const response = await requestJson(this.config, "POST", "/mailv2/auth/weblogin", {
      formBody: {
        uname: account.accountEmail,
        rsapwd: createHash("md5").update(account.password).digest("hex"),
        rememberLogin: false,
      },
      extraHeaders: {
        deviceUid: randomBytes(16).toString("hex"),
      },
    });

    if (!isSuccessfulEnvelope(response.status, response.body)) {
      throw buildMail2925StatusError("login", response.status, response.body);
    }

    const result = asRecord(readEnvelopeResult(response.body));
    if (result.secLogin === true) {
      throw new Mail2925ClientError("2925 account requires secondary login flow, which is not supported.", "auth");
    }

    const token = readString(result.token);
    if (!token) {
      throw new Mail2925ClientError("2925 login returned an empty access token.", "provider");
    }

    loginTokenCache.set(cacheKey, {
      token,
      expiresAtMs: Date.now() + LOGIN_CACHE_TTL_MS,
    });
    return token;
  }

  private async requestAuthorized(
    account: Mail2925AccountCredential,
    method: string,
    path: string,
    options: Omit<Mail2925RequestOptions, "token"> = {},
  ): Promise<unknown> {
    const configuredSessionToken = this.config.jwtToken?.trim();
    let token = configuredSessionToken || await this.login(account);
    const browserHeaders = {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${this.config.apiBase.replace(/\/$/, "")}/`,
      "User-Agent": MAIL2925_BROWSER_USER_AGENT,
      ...(options.extraHeaders ?? {}),
    };
    let response = await requestJson(this.config, method, path, {
      ...options,
      token,
      extraHeaders: browserHeaders,
    });

    const isAuthFailure = !isSuccessfulEnvelope(response.status, response.body)
      && classifyMail2925Error(readEnvelopeMessage(response.body) ?? `status ${response.status}`) === "auth";

    if (isAuthFailure && configuredSessionToken && this.canRefreshConfiguredSessionToken()) {
      token = await this.refreshConfiguredSessionToken();
      response = await requestJson(this.config, method, path, {
        ...options,
        token,
        extraHeaders: browserHeaders,
      });
    } else if (isAuthFailure && !configuredSessionToken) {
      token = await this.login(account, true);
      response = await requestJson(this.config, method, path, {
        ...options,
        token,
        extraHeaders: browserHeaders,
      });
    }

    if (!isSuccessfulEnvelope(response.status, response.body)) {
      throw buildMail2925StatusError(path, response.status, response.body);
    }

    return response.body;
  }

  private async getMessageWithPythonFallback(
    account: Mail2925AccountCredential,
    messageId: string,
    folderName: string,
  ): Promise<Record<string, unknown>> {
    const browserHeaders = {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${this.config.apiBase.replace(/\/$/, "")}/`,
      "User-Agent": MAIL2925_BROWSER_USER_AGENT,
      ...(this.config.deviceUid ? { deviceUid: this.config.deviceUid } : {}),
      ...(this.config.cookieHeader ? { Cookie: this.config.cookieHeader } : {}),
    };

    const executeWithToken = async (token: string) => {
      const response = await requestJsonWithPython(
        "GET",
        `${this.config.apiBase.replace(/\/$/, "")}/mailv2/maildata/MailRead/mails/read`,
        {
          ...browserHeaders,
          Authorization: `Bearer ${token}`,
        },
        {
          MessageID: messageId,
          FolderName: folderName,
          MailBox: account.accountEmail,
          IsPre: false,
        },
        this.config.timeoutSeconds,
      );

      if (!isSuccessfulEnvelope(response.status, response.body)) {
        throw buildMail2925StatusError("pythonDetailRead", response.status, response.body);
      }

      return asRecord(readEnvelopeResult(response.body));
    };

    let token = this.config.jwtToken?.trim() || await this.login(account);
    try {
      return await executeWithToken(token);
    } catch (error) {
      const classified = classifyThrownError(error);
      if (classified.kind !== "auth" || !this.canRefreshConfiguredSessionToken()) {
        throw error;
      }
    }

    token = await this.refreshConfiguredSessionToken();
    return executeWithToken(token);
  }

  private async refreshConfiguredSessionToken(): Promise<string> {
    if (!this.canRefreshConfiguredSessionToken()) {
      throw new Mail2925ClientError("2925 browser session refresh requires deviceUid and cookieHeader.", "auth");
    }

    const browserHeaders = {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${this.config.apiBase.replace(/\/$/, "")}/`,
      "User-Agent": MAIL2925_BROWSER_USER_AGENT,
    };
    const response = await requestJson(this.config, "POST", "/mailv2/auth/token", {
      formBody: {},
      extraHeaders: browserHeaders,
    });

    if (!isSuccessfulEnvelope(response.status, response.body)) {
      throw buildMail2925StatusError("refreshToken", response.status, response.body);
    }

    const result = readEnvelopeResult(response.body);
    const token = readString(result);
    if (!token) {
      throw new Mail2925ClientError("2925 token refresh returned an empty access token.", "provider");
    }

    this.config.jwtToken = token;
    return token;
  }

  public async listFolders(account: Mail2925AccountCredential): Promise<string[]> {
    const body = await this.requestAuthorized(account, "GET", "/mailv2/UserData/folders", {
      query: {
        accountName: account.accountEmail,
      },
    });
    return extractFolderNames(body);
  }

  public async createMailbox(options: {
    sessionHint: string;
    requestedDomain?: string;
    createdAt?: string;
  }): Promise<Mail2925MailboxRefPayload> {
    return this.withCredential("generate", options.sessionHint, async (account) => {
      await this.login(account);
      // 2925's public webmail API can authenticate the backing account, but it does
      // not expose alias provisioning. Returning a synthetic alias address produces
      // non-deliverable mailboxes. Bind sessions to the verified account inbox so the
      // provider remains usable for real receive/OTP flows.
      return {
        aliasAddress: account.accountEmail,
        accountEmail: account.accountEmail,
        folderName: this.config.folderName,
        credentialSetId: account.selection.set.id,
        credentialItemId: account.selection.item.id,
        createdAt: options.createdAt,
      };
    });
  }

  public async listMessages(
    account: Mail2925AccountCredential,
    folderName = this.config.folderName,
  ): Promise<Record<string, unknown>[]> {
    const body = await this.requestAuthorized(account, "GET", "/mailv2/maildata/MailList/mails", {
      query: {
        Folder: folderName,
        MailBox: account.accountEmail,
        FilterType: 0,
        PageIndex: 0,
        PageCount: 20,
      },
    });

    return extractMessageList(body);
  }

  public async getMessage(
    account: Mail2925AccountCredential,
    messageId: string,
    folderName = this.config.folderName,
  ): Promise<Record<string, unknown>> {
    try {
      const body = await this.requestAuthorized(account, "GET", "/mailv2/maildata/MailRead/mails/read", {
        query: {
          MessageID: messageId,
          FolderName: folderName,
          MailBox: account.accountEmail,
          IsPre: false,
        },
      });

      return asRecord(readEnvelopeResult(body));
    } catch (error) {
      if (!this.canRefreshConfiguredSessionToken()) {
        throw error;
      }
      return this.getMessageWithPythonFallback(account, messageId, folderName);
    }
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: Mail2925MailboxRefPayload,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    return this.withBoundCredential(mailbox, async (account) => {
      const messages = await this.listMessages(account, mailbox.folderName ?? this.config.folderName);
      const aliasAddress = normalizeAddress(mailbox.aliasAddress);
      if (!aliasAddress) {
        return undefined;
      }

      // 2925 API returns messages newest-first. We iterate in that order
      // and stop early when messages are older than 30 minutes (stale).
      const staleThresholdMs = 30 * 60 * 1000;
      const nowMs = Date.now();

      for (const summary of messages) {
        // Check message age — stop scanning if older than 30 minutes.
        const messageTimeMs = readMessageTimestampMs(summary);
        if (messageTimeMs > 0 && (nowMs - messageTimeMs) > staleThresholdMs) {
          break;
        }

        const sender = readSender(summary);
        if (!matchesSenderFilter(sender, fromContains)) {
          continue;
        }

        const summaryRecipients = readRecipients(summary);
        const aliasMatchesSummary = summaryRecipients.length > 0
          ? matchesAliasRecipient(summaryRecipients, aliasAddress, account.accountEmail)
          : false;

        // If the summary already has recipients and none match the alias,
        // skip this message entirely — no need to fetch detail.
        if (summaryRecipients.length > 0 && !aliasMatchesSummary) {
          continue;
        }

        const messageId = readMessageId(summary);
        const subject = readMessageSubject(summary);
        const summaryText = readMessageText(summary);
        const summaryHtml = readMessageHtml(summary);
        const observedAt = readObservedAt(summary) ?? "";
        const summaryOtp = extractOtp({
          subject,
          textBody: summaryText,
          htmlBody: summaryHtml,
        });

        if (aliasMatchesSummary && (summaryText || summaryHtml) && !messageId) {
          return {
            id: `mail2925:${summaryOtp?.code ?? observedAt ?? "summary"}`,
            sessionId,
            providerInstanceId,
            observedAt,
            sender,
            subject,
            textBody: summaryText,
            htmlBody: summaryHtml,
            extractedCode: summaryOtp?.code,
            codeSource: summaryOtp?.source,
          };
        }

        if (!messageId) {
          continue;
        }

        let detail: Record<string, unknown> = {};
        try {
          detail = await this.getMessage(account, messageId, mailbox.folderName ?? this.config.folderName);
        } catch {
          if (!aliasMatchesSummary || (!summaryText && !summaryHtml)) {
            continue;
          }

          return {
            id: `mail2925:${messageId}`,
            sessionId,
            providerInstanceId,
            observedAt,
            sender,
            subject,
            textBody: summaryText,
            htmlBody: summaryHtml,
            extractedCode: summaryOtp?.code,
            codeSource: summaryOtp?.source,
          };
        }
        const recipients = readRecipients(detail);
        const aliasMatches = recipients.length > 0
          ? matchesAliasRecipient(recipients, aliasAddress, account.accountEmail)
          : (
            normalizeFilter(readMessageSubject(detail))?.includes(aliasAddress)
            || normalizeFilter(readMessageText(detail))?.includes(aliasAddress)
            || normalizeFilter(readMessageHtml(detail))?.includes(aliasAddress)
          );
        if (!aliasMatches) {
          continue;
        }

        const detailSender = readSender(detail) ?? sender;
        if (!matchesSenderFilter(detailSender, fromContains)) {
          continue;
        }

        const detailSubject = readMessageSubject(detail) ?? subject;
        const detailText = readMessageText(detail) ?? summaryText;
        const detailHtml = readMessageHtml(detail) ?? summaryHtml;
        const detailOtp = extractOtp({
          subject: detailSubject,
          textBody: detailText,
          htmlBody: detailHtml,
        });
        if (!detailOtp) {
          if (!aliasMatchesSummary || (!summaryText && !summaryHtml)) {
            continue;
          }

          return {
            id: `mail2925:${messageId}`,
            sessionId,
            providerInstanceId,
            observedAt,
            sender,
            subject,
            textBody: summaryText,
            htmlBody: summaryHtml,
            extractedCode: summaryOtp?.code,
            codeSource: summaryOtp?.source,
          };
        }
        return {
          id: `mail2925:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: readObservedAt(detail) ?? observedAt,
          sender: detailSender,
          subject: detailSubject,
          textBody: detailText,
          htmlBody: detailHtml,
          extractedCode: detailOtp.code,
          codeSource: detailOtp.source,
        };
      }

      return undefined;
    });
  }
}

export function encodeMail2925MailboxRef(instanceId: string, mailbox: Mail2925MailboxRefPayload): string {
  return `mail2925:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeMail2925MailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): Mail2925MailboxRefPayload | undefined {
  const prefix = `mail2925:${expectedInstanceId}:`;
  if (!mailboxRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(mailboxRef.slice(prefix.length))) as Record<string, unknown>;
    const aliasAddress = normalizeAddress(readString(payload.aliasAddress));
    const accountEmail = normalizeAddress(readString(payload.accountEmail));
    if (!aliasAddress || !accountEmail) {
      return undefined;
    }

    return {
      aliasAddress,
      accountEmail,
      folderName: readString(payload.folderName),
      credentialSetId: readString(payload.credentialSetId),
      credentialItemId: readString(payload.credentialItemId),
      createdAt: readString(payload.createdAt),
    };
  } catch {
    return undefined;
  }
}

export async function probeMail2925Instance(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = Mail2925Client.fromInstance(instance, credentialSets);
  if (!client) {
    return {
      ok: false,
      detail: "2925 instance is missing credentialSets/account/password/accountsFile configuration.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    const probeMailbox = await client.createMailbox({
      sessionHint: "probe",
      createdAt: new Date(startedAt).toISOString(),
    });
    const account = client.resolveBoundCredential(probeMailbox);
    const folders = account ? await client.listFolders(account) : [];

    return {
      ok: folders.includes("Inbox"),
      detail: folders.includes("Inbox")
        ? `MAIL2925_PROBE_OK: 2925 login succeeded and returned ${folders.length} folders.`
        : "MAIL2925_MAILBOX_DELIVERY_FAILURE: 2925 login succeeded but Inbox was not visible.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "mail2925",
        accountEmail: probeMailbox.accountEmail,
        folders: String(folders.length),
      },
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "mail2925",
        errorClass: classifyMail2925Error(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}
