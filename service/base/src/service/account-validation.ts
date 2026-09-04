import { EasyEmailError } from "../domain/errors.js";
import type {
  MailAccount,
  MailAccountAuthStatus,
  MailAccountCreateInput,
  MailAccountImapProfile,
  MailAccountKind,
  MailAccountListPosition,
  MailAccountReceiveStatus,
  MailAccountScope,
  MailAccountSendStatus,
  MailAccountStatus,
} from "../domain/account.js";

export const DEFAULT_ACCOUNT_PAGE_SIZE = 50;
export const MAX_ACCOUNT_PAGE_SIZE = 100;
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
export const ACCOUNT_CREATE_FIELDS = new Set([
  "scope",
  "kind",
  "displayName",
  "primaryAddress",
  "providerLabel",
  "imap",
  "listedInAllAccounts",
  "credentialRefs",
]);
export const ACCOUNT_UPDATE_FIELDS = new Set([
  "expectedVersion",
  "displayName",
  "providerLabel",
  "imap",
  "listedInAllAccounts",
]);
export const ACCOUNT_DELETE_FIELDS = new Set(["expectedVersion"]);
const CREDENTIAL_REF_FIELDS = new Set([
  "secretBackend",
  "secretKey",
  "credentialKind",
  "authMethod",
]);
const IMAP_PROFILE_FIELDS = new Set(["host", "port", "security", "username"]);
export const IMAP_TEST_FIELDS = new Set(["accountId", "credentialRefId"]);

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function normalizeScope(value: unknown): MailAccountScope {
  if (value !== "normal" && value !== "agent" && value !== "system") {
    throw new EasyEmailError("ACCOUNT_SCOPE_UNSUPPORTED", "Account scope must be normal, agent, or system.");
  }
  return value;
}

export function normalizeKind(value: unknown): MailAccountKind {
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

export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new EasyEmailError("INVALID_ACCOUNT", "displayName must be a string.");
  }
  const normalized = value.trim().split(/\s+/u).filter(Boolean).join(" ");
  if (!normalized || Array.from(normalized).length > 128) {
    throw new EasyEmailError("INVALID_ACCOUNT", "displayName must contain from 1 to 128 characters.");
  }
  return normalized;
}

export function normalizeOptionalLabel(value: unknown, field: string): string | undefined {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new EasyEmailError("INVALID_ACCOUNT", `${field} must be a string or null.`);
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (Array.from(normalized).length > 128) {
    throw new EasyEmailError("INVALID_ACCOUNT", `${field} must contain at most 128 characters.`);
  }
  return normalized || undefined;
}

export function normalizeEmail(value: unknown): string | undefined {
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

export function normalizeExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EasyEmailError("INVALID_ACCOUNT", "expectedVersion must be a positive integer.");
  }
  return value;
}

export function normalizeOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new EasyEmailError("INVALID_ACCOUNT", `${field} must be a boolean.`);
  }
  return value;
}

export function normalizeImapProfile(value: unknown, allowNull = false): MailAccountImapProfile | undefined {
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

export function assertNoRawSecretFields(value: unknown, seen = new Set<object>()): void {
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

export function assertOnlyKnownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new EasyEmailError("INVALID_ACCOUNT", `${context} field is unsupported: ${unknown}.`);
  }
}

export function normalizeCredentialRefs(value: unknown): MailAccountCreateInput["credentialRefs"] {
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

export function encodeCursor(item: MailAccount, scope: MailAccountScope | undefined): string {
  const position: MailAccountListPosition = {
    filterScope: scope ?? "all",
    createdAt: item.createdAt,
    id: item.id,
  };
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, expectedScope: MailAccountScope | undefined): MailAccountListPosition {
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

export function sqliteUniqueConstraint(error: unknown): "address" | "credential-ref" | undefined {
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

export function initialState(kind: MailAccountKind): {
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
