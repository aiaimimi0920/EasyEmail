import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import { restoreRelationalDatabaseBackup } from "./database-backup.js";
import {
  isRelationalDatabaseOpen,
  openRelationalDatabase,
  releaseRelationalDatabasePath,
} from "./database-bootstrap.js";
import {
  readAndMapLegacyAccounts,
  type LegacyCredentialProbeInput,
  type LegacyCredentialVaultCheck,
} from "./legacy-account-mapper.js";
import {
  assertLegacySourceUnchanged,
  prepareLegacyEasyEmailAmSourceSnapshot,
} from "./legacy-source-backup.js";

export const LEGACY_ACCOUNT_IMPORTER_VERSION = 1;

export type { LegacyCredentialProbeInput, LegacyCredentialVaultCheck };

export interface LegacyAccountImportReceipt {
  id: string;
  importerVersion: number;
  domain: "accounts";
  sourceSha256: string;
  sourceSchemaVersion: number;
  sourceAccountCount: number;
  sourceCredentialRefCount: number;
  importedAccountCount: number;
  skippedExistingCount: number;
  reauthRequiredCount: number;
  importedAt: string;
}

export interface LegacyAccountImportOptions {
  sourceDatabasePath: string;
  targetDatabasePath: string;
  backupDirectory?: string;
  vaultExistenceCheck?: LegacyCredentialVaultCheck;
  now?: () => Date;
  beforeCommitHook?: () => void;
}

export interface LegacyAccountImportResult {
  receipt: LegacyAccountImportReceipt;
  sourceBackupDirectory: string;
  targetPreImportBackupPath?: string;
  skippedAnonymousCount: number;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createTargetPreImportBackup(targetPath: string, now: Date): string {
  const backupPath = `${targetPath}.before-legacy-import-${now.toISOString().replaceAll(":", "-")}-${randomUUID()}.bak`;
  const existing = new DatabaseSync(targetPath, { readOnly: true });
  try {
    existing.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  } finally {
    existing.close();
  }
  return backupPath;
}

function cleanupNewTargetTrio(targetPath: string): void {
  for (const candidate of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`]) {
    rmSync(candidate, { force: true });
  }
}

export async function importLegacyEasyEmailAmAccounts(
  options: LegacyAccountImportOptions,
): Promise<LegacyAccountImportResult> {
  const nowFn = options.now ?? (() => new Date());
  const resolvedTarget = resolve(options.targetDatabasePath);
  if (isRelationalDatabaseOpen(resolvedTarget)) {
    throw new EasyEmailError(
      "LEGACY_IMPORT_TARGET_OPEN",
      "Close the EasyEmail relational database before running the legacy account importer.",
    );
  }

  const sourceBackup = prepareLegacyEasyEmailAmSourceSnapshot({
    sourceDatabasePath: options.sourceDatabasePath,
    targetDatabasePath: resolvedTarget,
    backupRootDirectory: options.backupDirectory,
    now: nowFn(),
  });

  const snapshotReader = new DatabaseSync(sourceBackup.snapshotDatabasePath, { readOnly: true });
  let mappedResult: Awaited<ReturnType<typeof readAndMapLegacyAccounts>>;
  try {
    mappedResult = await readAndMapLegacyAccounts(snapshotReader, options.vaultExistenceCheck);
  } finally {
    snapshotReader.close();
  }

  const targetExisted = existsSync(resolvedTarget);
  const targetPreImportBackupPath = targetExisted
    ? createTargetPreImportBackup(resolvedTarget, nowFn())
    : undefined;

  const opened = openRelationalDatabase({ databasePath: resolvedTarget, now: nowFn });
  const targetDb = opened.database;
  let closed = false;
  const closeTarget = (): void => {
    if (closed) return;
    closed = true;
    try {
      targetDb.close();
    } finally {
      releaseRelationalDatabasePath(opened.trackedDatabasePath);
    }
  };

  try {
    const importedAt = nowFn().toISOString();
    const receiptId = `impr_v1_${randomUUID()}`;
    let importedAccountCount = 0;
    let skippedExistingCount = 0;
    let reauthRequiredCount = 0;

    const findByIdStmt = targetDb.prepare(
      "SELECT id, kind, primary_address, deleted_at FROM mail_accounts WHERE id = ?",
    );
    const findLiveAddressStmt = targetDb.prepare(`
      SELECT id FROM mail_accounts
      WHERE lower(primary_address) = lower(?) AND deleted_at IS NULL
    `);
    const findCredentialConflictStmt = targetDb.prepare(`
      SELECT owner_account_id FROM mail_account_credential_refs
      WHERE secret_backend = ? AND secret_key = ?
    `);
    const insertAccountStmt = targetDb.prepare(`
      INSERT INTO mail_accounts (
        id, scope, kind, display_name, primary_address, provider_label,
        imap_host, imap_port, imap_security, imap_username,
        status, auth_status, receive_status, send_status,
        listed_in_all_accounts, version, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `);
    const insertCredentialStmt = targetDb.prepare(`
      INSERT INTO mail_account_credential_refs (
        id, owner_account_id, secret_backend, secret_key, credential_kind,
        auth_method, status, created_at, updated_at, last_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    targetDb.exec("BEGIN IMMEDIATE");
    try {
      for (const account of mappedResult.accounts) {
        const existing = findByIdStmt.get(account.id) as {
          id: string;
          kind: string;
          primary_address: string | null;
        } | undefined;
        if (existing) {
          if (
            existing.kind !== account.kind
            || (existing.primary_address ?? "").toLowerCase() !== account.primaryAddress.toLowerCase()
          ) {
            throw new EasyEmailError(
              "LEGACY_IMPORT_CONFLICT",
              `Existing canonical account ${account.id} conflicts with legacy account metadata.`,
            );
          }
          skippedExistingCount += 1;
          continue;
        }

        if (account.deletedAt === null) {
          const liveConflict = findLiveAddressStmt.get(account.primaryAddress) as { id: string } | undefined;
          if (liveConflict) {
            throw new EasyEmailError(
              "LEGACY_IMPORT_ADDRESS_CONFLICT",
              `Canonical account ${liveConflict.id} already owns address ${account.primaryAddress}.`,
            );
          }
        }

        insertAccountStmt.run(
          account.id,
          account.scope,
          account.kind,
          account.displayName,
          account.primaryAddress,
          account.providerLabel,
          account.imap?.host ?? null,
          account.imap?.port ?? null,
          account.imap?.security ?? null,
          account.imap?.username ?? null,
          account.status,
          account.authStatus,
          account.receiveStatus,
          account.sendStatus,
          account.listedInAllAccounts ? 1 : 0,
          account.createdAt,
          account.updatedAt,
          account.deletedAt,
        );

        for (const ref of account.credentialRefs) {
          const ownerConflict = findCredentialConflictStmt.get(ref.secretBackend, ref.secretKey) as {
            owner_account_id: string;
          } | undefined;
          if (ownerConflict && ownerConflict.owner_account_id !== account.id) {
            throw new EasyEmailError(
              "LEGACY_IMPORT_CREDENTIAL_CONFLICT",
              `Credential reference ${ref.secretKey} is already owned by another account.`,
            );
          }
          insertCredentialStmt.run(
            ref.id,
            ref.ownerAccountId,
            ref.secretBackend,
            ref.secretKey,
            ref.credentialKind,
            ref.authMethod,
            ref.status,
            ref.createdAt,
            ref.updatedAt,
            ref.lastVerifiedAt,
          );
        }

        importedAccountCount += 1;
        if (account.reauthMarked) {
          reauthRequiredCount += 1;
        }
      }

      const fkViolations = targetDb.prepare("PRAGMA foreign_key_check").all();
      if (fkViolations.length > 0) {
        throw new EasyEmailError("LEGACY_IMPORT_VERIFICATION_FAILED", "Target database failed foreign_key_check.");
      }

      targetDb.prepare(`
        INSERT INTO legacy_import_receipts (
          id, importer_version, domain, source_sha256, source_schema_version,
          source_account_count, source_credential_ref_count,
          imported_account_count, skipped_existing_count, reauth_required_count, imported_at
        ) VALUES (?, ?, 'accounts', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId,
        LEGACY_ACCOUNT_IMPORTER_VERSION,
        sourceBackup.sourceSha256,
        sourceBackup.maxMigrationVersion,
        sourceBackup.sourceAccountCount,
        sourceBackup.sourceCredentialRefCount,
        importedAccountCount,
        skippedExistingCount,
        reauthRequiredCount,
        importedAt,
      );

      options.beforeCommitHook?.();
      targetDb.exec("COMMIT");
    } catch (txError) {
      targetDb.exec("ROLLBACK");
      throw txError;
    }

    const receipt: LegacyAccountImportReceipt = {
      id: receiptId,
      importerVersion: LEGACY_ACCOUNT_IMPORTER_VERSION,
      domain: "accounts",
      sourceSha256: sourceBackup.sourceSha256,
      sourceSchemaVersion: sourceBackup.maxMigrationVersion,
      sourceAccountCount: sourceBackup.sourceAccountCount,
      sourceCredentialRefCount: sourceBackup.sourceCredentialRefCount,
      importedAccountCount,
      skippedExistingCount,
      reauthRequiredCount,
      importedAt,
    };

    closeTarget();
    assertLegacySourceUnchanged(sourceBackup);
    return {
      receipt,
      sourceBackupDirectory: sourceBackup.snapshotDirectory,
      targetPreImportBackupPath,
      skippedAnonymousCount: mappedResult.skippedAnonymousCount,
    };
  } catch (error) {
    closeTarget();
    if (targetExisted && targetPreImportBackupPath) {
      restoreRelationalDatabaseBackup(resolvedTarget, targetPreImportBackupPath);
    } else if (!targetExisted) {
      cleanupNewTargetTrio(resolvedTarget);
    }
    assertLegacySourceUnchanged(sourceBackup);
    throw error;
  }
}
