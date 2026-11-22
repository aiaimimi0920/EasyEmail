import type { DatabaseSync } from "node:sqlite";

import type {
  MailAccountAuthStatus,
  MailAccountImapProfile,
  MailAccountKind,
  MailAccountReceiveStatus,
  MailAccountScope,
  MailAccountSendStatus,
  MailAccountStatus,
  MailCredentialRef,
} from "../../domain/account.js";
import { EasyEmailError } from "../../domain/errors.js";
import {
  assertNoRawSecretFields,
  normalizeDisplayName,
  normalizeEmail,
  normalizeImapProfile,
  normalizeKind,
  normalizeOptionalLabel,
  normalizeScope,
} from "../../service/account-validation.js";

const ALLOWED_STATUSES = new Set<MailAccountStatus>([
  "ready", "configuring", "syncing", "degraded", "disabled", "history_only", "deleted",
]);
const ALLOWED_AUTH_STATUSES = new Set<MailAccountAuthStatus>([
  "not_required", "valid", "expired", "invalid", "missing", "refreshing", "reauthorization_required",
]);
const ALLOWED_RECEIVE_STATUSES = new Set<MailAccountReceiveStatus>([
  "enabled", "syncing", "backoff", "auth_failed", "provider_unavailable", "expired", "disabled", "unsupported",
]);
const ALLOWED_SEND_STATUSES = new Set<MailAccountSendStatus>([
  "enabled", "sending", "queued_only", "auth_failed", "smtp_unavailable", "rate_limited", "disabled", "unsupported",
]);
const ALLOWED_CREDENTIAL_STATUSES = new Set<MailCredentialRef["status"]>([
  "active", "missing", "invalid", "disabled",
]);

export interface LegacyCredentialProbeInput {
  accountId: string;
  credentialRefId: string;
  secretBackend: string;
  secretKey: string;
  credentialKind: string;
  authMethod: string;
}

export type LegacyCredentialVaultCheck = (
  input: LegacyCredentialProbeInput,
) => Promise<"present" | "missing"> | "present" | "missing";

export interface MappedLegacyCredentialRef {
  id: string;
  ownerAccountId: string;
  secretBackend: string;
  secretKey: string;
  credentialKind: string;
  authMethod: string;
  status: MailCredentialRef["status"];
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
}

export interface MappedLegacyAccount {
  id: string;
  scope: Exclude<MailAccountScope, "system">;
  kind: Exclude<MailAccountKind, "anonymous_virtual">;
  displayName: string;
  primaryAddress: string;
  providerLabel: string | null;
  imap: MailAccountImapProfile | undefined;
  status: MailAccountStatus;
  authStatus: MailAccountAuthStatus;
  receiveStatus: MailAccountReceiveStatus;
  sendStatus: MailAccountSendStatus;
  listedInAllAccounts: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  reauthMarked: boolean;
  credentialRefs: MappedLegacyCredentialRef[];
}

interface LegacyAccountSqlRow {
  id: string;
  scope: string;
  kind: string;
  display_name: string;
  primary_address: string | null;
  provider_label: string | null;
  status: string;
  auth_status: string;
  receive_status: string;
  send_status: string;
  listed_in_all_accounts: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface LegacyImapSourceSqlRow {
  config_json: string;
}

interface LegacyCredentialRefSqlRow {
  id: string;
  owner_account_id: string | null;
  secret_backend: string;
  secret_key: string;
  credential_kind: string;
  auth_method: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
}

function assertSafeIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy ${field} is invalid.`);
  }
  return trimmed;
}

function assertIsoTimestamp(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy ${field} timestamp is invalid.`);
  }
  return trimmed;
}

function assertOpaqueLegacySecretKey(secretKey: string): string {
  const trimmed = secretKey.trim();
  if (
    !trimmed
    || trimmed.length > 256
    || !(
      /^ref:v1:[A-Za-z0-9._:/-]+$/.test(trimmed)
      || /^secret:\/\/(imap|smtp|agent)\/[A-Za-z0-9._:-]+$/.test(trimmed)
    )
  ) {
    throw new EasyEmailError(
      "LEGACY_IMPORT_CREDENTIAL_REF_INVALID",
      "Legacy credential_refs entry does not contain a supported opaque reference key.",
    );
  }
  return trimmed;
}

function assertEnumValue<T extends string>(value: string, allowed: ReadonlySet<T>, field: string): T {
  if (!allowed.has(value as T)) {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy ${field} value is unsupported: ${value}.`);
  }
  return value as T;
}

function parseLegacyImapConfig(rawJson: string | undefined): MailAccountImapProfile | undefined {
  if (!rawJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", "Legacy IMAP mailbox_sources config_json is invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", "Legacy IMAP config_json must be an object.");
  }
  assertNoRawSecretFields(parsed);
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length === 0) return undefined;
  return normalizeImapProfile({
    host: record.host,
    port: record.port,
    security: record.security,
    username: record.username,
  });
}

export async function readAndMapLegacyAccounts(
  sourceDb: DatabaseSync,
  vaultCheck?: LegacyCredentialVaultCheck,
): Promise<{
  accounts: MappedLegacyAccount[];
  skippedAnonymousCount: number;
}> {
  const accountRows = sourceDb.prepare(`
    SELECT id, scope, kind, display_name, primary_address, provider_label,
           status, auth_status, receive_status, send_status,
           listed_in_all_accounts, created_at, updated_at, deleted_at
    FROM accounts
    ORDER BY created_at ASC, id ASC
  `).all() as unknown as LegacyAccountSqlRow[];

  const imapSourceStmt = sourceDb.prepare(`
    SELECT config_json
    FROM mailbox_sources
    WHERE account_id = ? AND source_kind = 'imap'
    ORDER BY updated_at DESC, id ASC
    LIMIT 1
  `);
  const credentialStmt = sourceDb.prepare(`
    SELECT id, owner_account_id, secret_backend, secret_key, credential_kind,
           auth_method, status, created_at, updated_at, last_verified_at
    FROM credential_refs
    WHERE owner_account_id = ?
    ORDER BY created_at ASC, id ASC
  `);

  let skippedAnonymousCount = 0;
  const mapped: MappedLegacyAccount[] = [];

  for (const row of accountRows) {
    const kind = normalizeKind(row.kind);
    const scope = normalizeScope(row.scope);
    if (kind === "anonymous_virtual") {
      if (scope !== "system") {
        throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", "Legacy anonymous_virtual account has invalid scope.");
      }
      skippedAnonymousCount += 1;
      continue;
    }
    if (
      scope === "system"
      || (kind === "agent_owned" && scope !== "agent")
      || (kind !== "agent_owned" && scope !== "normal")
    ) {
      throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy account ${row.id} has incompatible scope and kind.`);
    }
    const id = assertSafeIdentifier(row.id, "account.id");
    const primaryAddress = normalizeEmail(row.primary_address);
    if (!primaryAddress) {
      throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy account ${id} is missing primary_address.`);
    }
    const imapRow = imapSourceStmt.get(id) as unknown as LegacyImapSourceSqlRow | undefined;
    const imap = parseLegacyImapConfig(imapRow?.config_json);
    const rawRefs = credentialStmt.all(id) as unknown as LegacyCredentialRefSqlRow[];

    let missingVaultCredential = false;
    let missingSmtpCredential = false;
    const credentialRefs: MappedLegacyCredentialRef[] = [];
    for (const ref of rawRefs) {
      const refId = assertSafeIdentifier(ref.id, "credential_ref.id");
      const secretBackend = assertSafeIdentifier(ref.secret_backend, "credential_ref.secret_backend");
      const secretKey = assertOpaqueLegacySecretKey(ref.secret_key);
      const credentialKind = assertSafeIdentifier(ref.credential_kind, "credential_ref.credential_kind");
      const authMethod = assertSafeIdentifier(ref.auth_method, "credential_ref.auth_method");
      let status = assertEnumValue(ref.status, ALLOWED_CREDENTIAL_STATUSES, "credential_ref.status");

      if (row.deleted_at === null && vaultCheck && status !== "disabled") {
        const presence = await vaultCheck({
          accountId: id,
          credentialRefId: refId,
          secretBackend,
          secretKey,
          credentialKind,
          authMethod,
        });
        if (presence === "missing") {
          status = "missing";
          if (credentialKind === "smtp_password") {
            missingSmtpCredential = true;
          } else {
            missingVaultCredential = true;
          }
        }
      } else if (row.deleted_at === null && status === "missing") {
        if (credentialKind === "smtp_password") {
          missingSmtpCredential = true;
        } else {
          missingVaultCredential = true;
        }
      }

      credentialRefs.push({
        id: refId,
        ownerAccountId: id,
        secretBackend,
        secretKey,
        credentialKind,
        authMethod,
        status,
        createdAt: assertIsoTimestamp(ref.created_at, "credential_ref.created_at"),
        updatedAt: assertIsoTimestamp(ref.updated_at, "credential_ref.updated_at"),
        lastVerifiedAt: ref.last_verified_at
          ? assertIsoTimestamp(ref.last_verified_at, "credential_ref.last_verified_at")
          : null,
      });
    }

    let authStatus = assertEnumValue(row.auth_status, ALLOWED_AUTH_STATUSES, "account.auth_status");
    let receiveStatus = assertEnumValue(row.receive_status, ALLOWED_RECEIVE_STATUSES, "account.receive_status");
    let sendStatus = assertEnumValue(row.send_status, ALLOWED_SEND_STATUSES, "account.send_status");
    let reauthMarked = false;
    if (row.deleted_at === null && (missingVaultCredential || missingSmtpCredential)) {
      if (authStatus !== "reauthorization_required") {
        authStatus = "reauthorization_required";
      }
      if (missingVaultCredential && receiveStatus === "enabled") {
        receiveStatus = "auth_failed";
      }
      if (missingSmtpCredential && sendStatus === "enabled") {
        sendStatus = "auth_failed";
      }
      reauthMarked = true;
    }

    mapped.push({
      id,
      scope,
      kind,
      displayName: normalizeDisplayName(row.display_name),
      primaryAddress,
      providerLabel: normalizeOptionalLabel(row.provider_label, "providerLabel") ?? null,
      imap,
      status: assertEnumValue(row.status, ALLOWED_STATUSES, "account.status"),
      authStatus,
      receiveStatus,
      sendStatus,
      listedInAllAccounts: row.listed_in_all_accounts === 1,
      createdAt: assertIsoTimestamp(row.created_at, "account.created_at"),
      updatedAt: assertIsoTimestamp(row.updated_at, "account.updated_at"),
      deletedAt: row.deleted_at ? assertIsoTimestamp(row.deleted_at, "account.deleted_at") : null,
      reauthMarked,
      credentialRefs,
    });
  }

  return { accounts: mapped, skippedAnonymousCount };
}
