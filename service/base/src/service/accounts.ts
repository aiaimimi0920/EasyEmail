import { randomUUID } from "node:crypto";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailAccount,
  MailAccountCreateInput,
  MailAccountDeleteInput,
  MailAccountImapProfile,
  MailAccountKind,
  MailAccountAuthStatus,
  MailAccountListPosition,
  MailAccountListQuery,
  MailAccountListResult,
  MailAccountRepository,
  MailAccountScope,
  MailAccountStatus,
  MailAccountReceiveStatus,
  MailAccountSendStatus,
  MailAccountUpdateInput,
} from "../domain/account.js";
import type {
  MailAccountConnectivityDependencies,
  MailAccountImapTestRequest,
  MailImapConnectionTestResult,
} from "./account-connectivity.js";

const DEFAULT_ACCOUNT_PAGE_SIZE = 50;
const MAX_ACCOUNT_PAGE_SIZE = 100;
const FORBIDDEN_SECRET_FIELDS = new Set([
  "authorizationcode",
  "imappassword",
  "password",
  "rawsecret",
  "refreshtoken",
  "secret",
  "smtppassword",
  "token",
  "value",
]);
const ACCOUNT_CREATE_FIELDS = new Set([
  "scope",
  "kind",
  "displayName",
  "primaryAddress",
  "providerLabel",
  "imap",
  "listedInAllAccounts",
  "credentialRefs",
]);
const ACCOUNT_UPDATE_FIELDS = new Set([
  "expectedVersion",
  "displayName",
  "providerLabel",
  "imap",
  "listedInAllAccounts",
]);
const ACCOUNT_DELETE_FIELDS = new Set(["expectedVersion"]);
const CREDENTIAL_REF_FIELDS = new Set([
  "secretBackend",
  "secretKey",
  "credentialKind",
  "authMethod",
]);
const IMAP_PROFILE_FIELDS = new Set(["host", "port", "security", "username"]);
const IMAP_TEST_FIELDS = new Set(["accountId", "credentialRefId"]);

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function normalizeScope(value: unknown): MailAccountScope {
  if (value !== "normal" && value !== "agent" && value !== "system") {
    throw new EasyEmailError("ACCOUNT_SCOPE_UNSUPPORTED", "Account scope must be normal, agent, or system.");
  }
  return value;
}

function normalizeKind(value: unknown): MailAccountKind {
  if (
    value !== "normal_long_lived"
    && value !== "normal_upgraded_temp"
    && value !== "anonymous_virtual"
    && value !== "agent_owned"
  ) {
    throw new EasyEmailError("ACCOUNT_KIND_UNSUPPORTED", "Account kind is unsupported.");
  }
  return value;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new EasyEmailError("INVALID_ACCOUNT", "displayName must be a string.");
  }
  const normalized = value.trim().split(/\s+/u).filter(Boolean).join(" ");
  if (!normalized || Array.from(normalized).length > 128) {
    throw new EasyEmailError("INVALID_ACCOUNT", "displayName must contain from 1 to 128 characters.");
  }
  return normalized;
}

function normalizeOptionalLabel(value: unknown, field: string): string | undefined {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new EasyEmailError("INVALID_ACCOUNT", `${field} must be a string or null.`);
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (Array.from(normalized).length > 128) {
    throw new EasyEmailError("INVALID_ACCOUNT", `${field} must contain at most 128 characters.`);
  }
  return normalized || undefined;
}

function normalizeEmail(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new EasyEmailError("INVALID_ACCOUNT", "primaryAddress must be a string or null.");
  }
  const normalized = asciiLower(value.trim());
  if (!normalized || !normalized.includes("@") || normalized.startsWith("@") || normalized.endsWith("@")) {
    throw new EasyEmailError("INVALID_ACCOUNT", "primaryAddress must be a valid mailbox address.");
  }
  if (normalized.length > 320) {
    throw new EasyEmailError("INVALID_ACCOUNT", "primaryAddress is too long.");
  }
  return normalized;
}

function normalizeExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EasyEmailError("INVALID_ACCOUNT", "expectedVersion must be a positive integer.");
  }
  return value;
}

function normalizeOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new EasyEmailError("INVALID_ACCOUNT", `${field} must be a boolean.`);
  }
  return value;
}

function normalizeImapProfile(value: unknown, allowNull = false): MailAccountImapProfile | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    if (allowNull) return undefined;
    throw new EasyEmailError("INVALID_ACCOUNT", "imap must be an object.");
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new EasyEmailError("INVALID_ACCOUNT", "imap must be an object or null.");
  }
  assertNoRawSecretFields(value);
  const record = value as Record<string, unknown>;
  assertOnlyKnownFields(record, IMAP_PROFILE_FIELDS, "imap");
  const host = typeof record.host === "string" ? asciiLower(record.host.trim()) : "";
  if (!host || host.length > 253 || /[\s\u0000-\u001f\u007f]/u.test(host)) {
    throw new EasyEmailError("INVALID_ACCOUNT", "imap.host must be a valid non-empty host name.");
  }
  if (typeof record.port !== "number" || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535) {
    throw new EasyEmailError("INVALID_ACCOUNT", "imap.port must be an integer from 1 to 65535.");
  }
  const rawSecurity = typeof record.security === "string" ? asciiLower(record.security.trim()) : "";
  const security = rawSecurity === "ssl" ? "tls" : rawSecurity;
  if (security !== "tls" && security !== "starttls") {
    throw new EasyEmailError("INVALID_ACCOUNT", "imap.security must be tls, ssl, or starttls.");
  }
  const username = typeof record.username === "string" ? record.username.trim() : "";
  if (!username || username.length > 320 || /[\u0000-\u001f\u007f]/u.test(username)) {
    throw new EasyEmailError("INVALID_ACCOUNT", "imap.username must contain from 1 to 320 safe characters.");
  }
  return { protocol: "imap", host, port: record.port, security, username };
}

function assertNoRawSecretFields(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawSecretFields(item, seen);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_FIELDS.has(key.toLowerCase())) {
      throw new EasyEmailError(
        "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN",
        "Raw credential material must be stored through the OS vault broker.",
      );
    }
    assertNoRawSecretFields(nested, seen);
  }
}

function assertOnlyKnownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new EasyEmailError("INVALID_ACCOUNT", `${context} field is unsupported: ${unknown}.`);
  }
}

function normalizeCredentialRefs(value: unknown): MailAccountCreateInput["credentialRefs"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new EasyEmailError("INVALID_ACCOUNT", "credentialRefs must contain at most 16 items.");
  }
  const seenRefs = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new EasyEmailError("ACCOUNT_CREDENTIAL_REF_INVALID", "credentialRefs entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    assertOnlyKnownFields(record, CREDENTIAL_REF_FIELDS, "credentialRefs");
    const fields = ["secretBackend", "secretKey", "credentialKind", "authMethod"] as const;
    const normalized = Object.fromEntries(fields.map((field) => {
      const raw = record[field];
      if (typeof raw !== "string" || !raw.trim() || raw.length > 256) {
        throw new EasyEmailError("ACCOUNT_CREDENTIAL_REF_INVALID", `${field} must be a non-empty string.`);
      }
      return [field, raw.trim()];
    })) as Record<typeof fields[number], string>;
    if (!/^ref:v1:[A-Za-z0-9._:/-]+$/.test(normalized.secretKey)) {
      throw new EasyEmailError(
        "ACCOUNT_CREDENTIAL_REF_INVALID",
        "secretKey must be an opaque versioned credential reference.",
      );
    }
    for (const field of ["secretBackend", "credentialKind", "authMethod"] as const) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized[field])) {
        throw new EasyEmailError(
          "ACCOUNT_CREDENTIAL_REF_INVALID",
          `${field} must contain only opaque metadata characters.`,
        );
      }
    }
    const identity = `${normalized.secretBackend}\u0000${normalized.secretKey}`;
    if (seenRefs.has(identity)) {
      throw new EasyEmailError("ACCOUNT_CREDENTIAL_REF_INVALID", "credentialRefs must be unique.");
    }
    seenRefs.add(identity);
    return {
      ...normalized,
      secretKey: normalized.secretKey as `ref:v1:${string}`,
    };
  });
}

function encodeCursor(item: MailAccount, scope: MailAccountScope | undefined): string {
  const position: MailAccountListPosition = {
    filterScope: scope ?? "all",
    createdAt: item.createdAt,
    id: item.id,
  };
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedScope: MailAccountScope | undefined): MailAccountListPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    const record = parsed as Record<string, unknown>;
    const expectedFilterScope = expectedScope ?? "all";
    if (
      (record.filterScope !== "all"
        && record.filterScope !== "normal"
        && record.filterScope !== "agent"
        && record.filterScope !== "system")
      || record.filterScope !== expectedFilterScope
      || typeof record.createdAt !== "string"
      || !record.createdAt
      || Number.isNaN(Date.parse(record.createdAt))
      || typeof record.id !== "string"
      || !record.id
      || record.id.length > 256
    ) {
      throw new Error("invalid cursor fields");
    }
    return {
      filterScope: record.filterScope,
      createdAt: record.createdAt,
      id: record.id,
    };
  } catch {
    throw new EasyEmailError("INVALID_ACCOUNT_CURSOR", "Account cursor is invalid.");
  }
}

function sqliteUniqueConstraint(error: unknown): "address" | "credential-ref" | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (record.code !== "ERR_SQLITE_ERROR" || typeof record.message !== "string") return undefined;
  if (
    record.message.includes("idx_mail_accounts_live_address")
    || record.message.includes("mail_accounts.primary_address")
  ) return "address";
  if (
    record.message.includes("idx_mail_account_credential_refs_secret")
    || record.message.includes("mail_account_credential_refs.secret_backend")
  ) return "credential-ref";
  return undefined;
}

function initialState(kind: MailAccountKind): {
  status: MailAccountStatus;
  authStatus: MailAccountAuthStatus;
  receiveStatus: MailAccountReceiveStatus;
  sendStatus: MailAccountSendStatus;
  listedInAllAccounts: boolean;
} {
  if (kind === "agent_owned") {
    return {
      status: "configuring",
      authStatus: "missing",
      receiveStatus: "disabled",
      sendStatus: "disabled",
      listedInAllAccounts: false,
    };
  }
  return {
    status: "configuring",
    authStatus: "missing",
    receiveStatus: "disabled",
    sendStatus: "disabled",
    listedInAllAccounts: true,
  };
}

export class MailAccountService {
  public constructor(
    private readonly repository: MailAccountRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly connectivity: MailAccountConnectivityDependencies = {},
  ) {}

  public async listAccounts(query: MailAccountListQuery = {}): Promise<MailAccountListResult> {
    const scope = query.scope === undefined ? undefined : normalizeScope(query.scope);
    const limit = query.limit ?? DEFAULT_ACCOUNT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACCOUNT_PAGE_SIZE) {
      throw new EasyEmailError("INVALID_QUERY", `Account limit must be an integer from 1 to ${MAX_ACCOUNT_PAGE_SIZE}.`);
    }
    const result = await this.repository.listMailAccounts({
      scope,
      limit,
      after: query.cursor ? decodeCursor(query.cursor, scope) : undefined,
    });
    const last = result.accounts.at(-1);
    return {
      accounts: result.accounts,
      nextCursor: result.hasMore && last ? encodeCursor(last, scope) : undefined,
    };
  }

  public async getAccount(id: string): Promise<MailAccount> {
    const normalizedId = id.trim();
    const account = normalizedId ? await this.repository.getMailAccount(normalizedId) : undefined;
    if (!account) {
      throw new EasyEmailError("ACCOUNT_NOT_FOUND", `Account ${id} was not found.`);
    }
    return account;
  }

  public async createAccount(input: MailAccountCreateInput): Promise<MailAccount> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_ACCOUNT", "Account request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as unknown as Record<string, unknown>, ACCOUNT_CREATE_FIELDS, "Account");
    const kind = normalizeKind(input.kind);
    const scope = input.scope === undefined
      ? (kind === "agent_owned" ? "agent" : "normal")
      : normalizeScope(input.scope);
    if (
      (kind === "agent_owned" && scope !== "agent")
      || (kind !== "agent_owned" && kind !== "anonymous_virtual" && scope !== "normal")
      || kind === "anonymous_virtual"
      || kind === "normal_upgraded_temp"
    ) {
      throw new EasyEmailError("ACCOUNT_KIND_UNSUPPORTED", "Account kind and scope combination is unsupported.");
    }
    const primaryAddress = normalizeEmail(input.primaryAddress);
    if (!primaryAddress) {
      throw new EasyEmailError("INVALID_ACCOUNT", "primaryAddress is required for a user account.");
    }
    const state = initialState(kind);
    const now = this.now().toISOString();
    try {
      return await this.repository.createMailAccount({
        id: `acct_v1_${randomUUID()}`,
        scope,
        kind,
        displayName: normalizeDisplayName(input.displayName),
        primaryAddress,
        providerLabel: normalizeOptionalLabel(input.providerLabel, "providerLabel"),
        imap: normalizeImapProfile(input.imap),
        status: state.status,
        authStatus: state.authStatus,
        receiveStatus: state.receiveStatus,
        sendStatus: state.sendStatus,
        listedInAllAccounts: normalizeOptionalBoolean(
          input.listedInAllAccounts,
          "listedInAllAccounts",
        ) ?? state.listedInAllAccounts,
        credentialRefs: normalizeCredentialRefs(input.credentialRefs),
        now,
      });
    } catch (error) {
      const uniqueConstraint = sqliteUniqueConstraint(error);
      if (uniqueConstraint === "address") {
        throw new EasyEmailError("ACCOUNT_ADDRESS_CONFLICT", "Another account already uses that address.");
      }
      if (uniqueConstraint === "credential-ref") {
        throw new EasyEmailError(
          "ACCOUNT_CREDENTIAL_REF_CONFLICT",
          "The credential reference is already owned by another account.",
        );
      }
      throw error;
    }
  }

  public async updateAccount(id: string, input: MailAccountUpdateInput): Promise<MailAccount> {
    const existing = await this.getAccount(id);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_ACCOUNT", "Account update request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as unknown as Record<string, unknown>, ACCOUNT_UPDATE_FIELDS, "Account update");
    if (existing.kind === "anonymous_virtual") {
      throw new EasyEmailError("ACCOUNT_SYSTEM_MANAGED", "The anonymous virtual account is system-managed.");
    }
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    if (
      input.displayName === undefined
      && input.providerLabel === undefined
      && input.imap === undefined
      && input.listedInAllAccounts === undefined
    ) {
      throw new EasyEmailError("INVALID_ACCOUNT", "At least one account field must be updated.");
    }
    const updated = await this.repository.updateMailAccount({
      id: existing.id,
      expectedVersion,
      displayName: input.displayName === undefined
        ? existing.displayName
        : normalizeDisplayName(input.displayName),
      providerLabel: input.providerLabel === undefined
        ? existing.providerLabel
        : normalizeOptionalLabel(input.providerLabel, "providerLabel"),
      imap: input.imap === undefined ? existing.imap : normalizeImapProfile(input.imap, true),
      listedInAllAccounts: normalizeOptionalBoolean(
        input.listedInAllAccounts,
        "listedInAllAccounts",
      ) ?? existing.listedInAllAccounts,
      now: this.now().toISOString(),
    });
    if (!updated) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    return updated;
  }

  public async disableAccount(id: string, expectedVersion: number): Promise<MailAccount> {
    const existing = await this.getAccount(id);
    if (existing.kind === "anonymous_virtual") {
      throw new EasyEmailError("ACCOUNT_SYSTEM_MANAGED", "The anonymous virtual account is system-managed.");
    }
    const normalizedVersion = normalizeExpectedVersion(expectedVersion);
    if (existing.version !== normalizedVersion) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    const updated = await this.repository.disableMailAccount(
      existing.id,
      normalizedVersion,
      this.now().toISOString(),
    );
    if (!updated) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    return updated;
  }

  public async deleteAccount(id: string, input: MailAccountDeleteInput): Promise<{ id: string }> {
    const existing = await this.getAccount(id);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_ACCOUNT", "Account delete request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as unknown as Record<string, unknown>, ACCOUNT_DELETE_FIELDS, "Account delete");
    if (existing.kind === "anonymous_virtual") {
      throw new EasyEmailError("ACCOUNT_SYSTEM_MANAGED", "The anonymous virtual account is system-managed.");
    }
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    if (!await this.repository.deleteMailAccount(existing.id, expectedVersion, this.now().toISOString())) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    return { id: existing.id };
  }

  public async testImapConnection(
    input: MailAccountImapTestRequest,
  ): Promise<MailImapConnectionTestResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_ACCOUNT", "IMAP test request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as unknown as Record<string, unknown>, IMAP_TEST_FIELDS, "IMAP test");
    const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
    const credentialRefId = typeof input.credentialRefId === "string" ? input.credentialRefId.trim() : "";
    if (!accountId || accountId.length > 256 || !credentialRefId || credentialRefId.length > 256) {
      throw new EasyEmailError("INVALID_ACCOUNT", "accountId and credentialRefId must be non-empty strings.");
    }
    const account = await this.getAccount(accountId);
    if (account.kind === "anonymous_virtual" || account.status === "disabled") {
      throw new EasyEmailError("ACCOUNT_IMAP_TEST_UNSUPPORTED", "This account cannot test IMAP connectivity.");
    }
    if (!account.imap) {
      throw new EasyEmailError("ACCOUNT_IMAP_CONFIG_REQUIRED", "The account has no IMAP connection profile.");
    }
    const credentialRef = account.credentialRefs.find((item) => item.id === credentialRefId);
    if (
      !credentialRef
      || credentialRef.ownerAccountId !== account.id
      || credentialRef.credentialKind !== "imap_password"
      || credentialRef.authMethod !== "password"
      || credentialRef.status === "disabled"
      || credentialRef.status === "invalid"
    ) {
      throw new EasyEmailError(
        "ACCOUNT_REAUTHENTICATION_REQUIRED",
        "The account IMAP credential must be provided again.",
      );
    }
    const { credentialResolver, imapTester } = this.connectivity;
    if (!credentialResolver) {
      throw new EasyEmailError(
        "ACCOUNT_CREDENTIAL_UNAVAILABLE",
        "The credential resolver is unavailable in this runtime.",
      );
    }
    if (!imapTester) {
      throw new EasyEmailError("ACCOUNT_IMAP_TEST_UNAVAILABLE", "IMAP testing is unavailable in this runtime.");
    }
    let resolution;
    try {
      resolution = await credentialResolver.resolveCredential({
        account,
        credentialRef,
        useCase: "imap-test",
      });
    } catch {
      throw new EasyEmailError(
        "ACCOUNT_CREDENTIAL_UNAVAILABLE",
        "The credential resolver could not be reached.",
      );
    }
    if (resolution.status === "missing") {
      throw new EasyEmailError(
        "ACCOUNT_REAUTHENTICATION_REQUIRED",
        "The account IMAP credential must be provided again.",
      );
    }
    if (resolution.status !== "resolved" || typeof resolution.secret !== "string" || !resolution.secret) {
      throw new EasyEmailError("ACCOUNT_CREDENTIAL_UNAVAILABLE", "The account credential is unavailable.");
    }
    try {
      const result = await imapTester.testConnection(account.imap, resolution.secret);
      if (result.authenticated !== true || typeof result.capabilitySummary !== "string") {
        throw new Error("invalid IMAP test result");
      }
      const capabilitySummary = result.capabilitySummary
        .slice(0, 4096)
        .split(resolution.secret).join("[redacted]")
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .slice(0, 1024);
      return {
        authenticated: true,
        capabilitySummary,
      };
    } catch (error) {
      if (error instanceof EasyEmailError && error.code === "IMAP_AUTH_FAILED") {
        throw error;
      }
      throw new EasyEmailError("ACCOUNT_IMAP_UNAVAILABLE", "The IMAP server could not be reached.");
    }
  }
}

export function createMailAccountService(
  repository: MailAccountRepository,
  now?: () => Date,
  connectivity?: MailAccountConnectivityDependencies,
): MailAccountService {
  return new MailAccountService(repository, now, connectivity);
}
