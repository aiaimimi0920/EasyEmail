import { createHash, randomBytes } from "node:crypto";
import {
  markCredentialCriticalFailure,
  markCredentialFailure,
  markCredentialSuccess,
  selectCredentialItem,
  type CredentialSelection,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { buildAliasAddress, normalizeAccountAddress } from "./alias.js";
import { resolveMail2925Config } from "./configuration.js";
import {
  buildMail2925StatusError,
  classifyMail2925Error,
  classifyThrownError,
  Mail2925ClientError,
} from "./failure.js";
import {
  MAIL2925_BROWSER_USER_AGENT,
  requestJson,
  requestJsonWithPython,
} from "./http.js";
import {
  asRecord,
  extractFolderNames,
  extractMessageList,
  isSuccessfulEnvelope,
  normalizeAddress,
  readEnvelopeMessage,
  readEnvelopeResult,
  readString,
} from "./payload.js";
import { tryReadLatestMail2925Code } from "./polling.js";
import type {
  Mail2925AccountCredential,
  Mail2925Config,
  Mail2925MailboxRefPayload,
  Mail2925RequestOptions,
  Mail2925TokenCacheEntry,
} from "./types.js";

export { resolveMail2925Config, resolveMail2925CredentialSets } from "./configuration.js";
export { decodeMail2925MailboxRef, encodeMail2925MailboxRef } from "./mailbox-ref.js";
export type { Mail2925Config, Mail2925MailboxRefPayload } from "./types.js";

const LOGIN_CACHE_TTL_MS = 10 * 60_000;
const loginTokenCache = new Map<string, Mail2925TokenCacheEntry>();

function buildLoginCacheKey(namespace: string, selection: CredentialSelection): string {
  return `${namespace}::${selection.set.id}::${selection.item.id}`;
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
      const aliasAddress = buildAliasAddress(
        account,
        options.sessionHint,
        this.config.aliasSeparator,
        this.config.aliasSuffixLength,
        options.requestedDomain,
      );
      return {
        aliasAddress,
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
    return this.withBoundCredential(mailbox, async (account) => tryReadLatestMail2925Code({
      sessionId,
      mailbox,
      providerInstanceId,
      fromContains,
      account,
      defaultFolderName: this.config.folderName,
      listMessages: (folderName) => this.listMessages(account, folderName),
      getMessage: (messageId, folderName) => this.getMessage(account, messageId, folderName),
    }));
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
