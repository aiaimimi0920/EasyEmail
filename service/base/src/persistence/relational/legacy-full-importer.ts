import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type { MailboxSession } from "../../domain/mailbox-models.js";
import { restoreRelationalDatabaseBackup } from "./database-backup.js";
import {
  isRelationalDatabaseOpen,
  openRelationalDatabase,
  releaseRelationalDatabasePath,
} from "./database-bootstrap.js";
import {
  readAndMapLegacyAccounts,
  type LegacyCredentialVaultCheck,
} from "./legacy-account-mapper.js";
import { readAndMapLegacyCatalogDomains } from "./legacy-domain-mappers.js";
import {
  readAndMapLegacyMailActivityDomains,
  type LegacyMessageSampleHash,
} from "./legacy-mail-activity-mappers.js";
import {
  assertLegacySourceUnchanged,
  prepareLegacyEasyEmailAmSourceSnapshot,
} from "./legacy-source-backup.js";
import {
  writeLegacyDomainsIntoTargetTransaction,
  type LegacyTargetDomainCounts,
} from "./legacy-target-writer.js";

export const LEGACY_FULL_IMPORTER_VERSION = 2;

export type { LegacyMessageSampleHash, LegacyTargetDomainCounts };

export interface LegacyFullImportReceipt {
  id: string;
  importerVersion: number;
  domain: "full_database";
  sourceSha256: string;
  sourceSchemaVersion: number;
  sourceTableRowCounts: Record<string, number>;
  importedCounts: LegacyTargetDomainCounts;
  skippedExistingCounts: LegacyTargetDomainCounts;
  reauthRequiredCount: number;
  queueStatusSummary: Record<string, number>;
  verifiedMessageSamples: LegacyMessageSampleHash[];
  importedAt: string;
}

export interface LegacyFullImportOptions {
  sourceDatabasePath: string;
  targetDatabasePath: string;
  targetStateFilePath?: string;
  defaultHostId?: string;
  backupDirectory?: string;
  vaultExistenceCheck?: LegacyCredentialVaultCheck;
  requireAllFoundationTables?: boolean;
  now?: () => Date;
  beforeCommitHook?: () => void;
}

export interface LegacyFullImportResult {
  receipt: LegacyFullImportReceipt;
  sourceBackupDirectory: string;
  targetPreImportBackupPath?: string;
  targetStateBackupPath?: string;
  skippedAnonymousCount: number;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createTargetPreImportBackup(targetPath: string, now: Date): string {
  const backupPath = `${targetPath}.before-legacy-full-import-${now.toISOString().replaceAll(":", "-")}-${randomUUID()}.bak`;
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

function mergeTempSessionsIntoStateFile(
  stateFilePath: string,
  incomingSessions: MailboxSession[],
): { importedCount: number; skippedCount: number } {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  let root: Record<string, unknown> = {
    providerTypes: [],
    runtimeTemplates: [],
    instances: [],
    bindings: [],
    strategies: [],
    credentialSets: [],
    credentialBindings: [],
    sessions: [],
    messages: [],
  };
  if (existsSync(stateFilePath)) {
    const rawText = readFileSync(stateFilePath, "utf8").trim();
    if (rawText) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new EasyEmailError(
          "LEGACY_IMPORT_STATE_CORRUPT",
          "Existing EasyEmail state snapshot JSON is invalid.",
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new EasyEmailError(
          "LEGACY_IMPORT_STATE_CORRUPT",
          "Existing EasyEmail state snapshot must be a JSON object.",
        );
      }
      root = { ...root, ...(parsed as Record<string, unknown>) };
    }
  }

  const existingSessions = Array.isArray(root.sessions)
    ? [...(root.sessions as MailboxSession[])]
    : [];
  const byId = new Map(existingSessions.map((session) => [session.id, session]));
  let importedCount = 0;
  let skippedCount = 0;

  for (const incoming of incomingSessions) {
    const existing = byId.get(incoming.id);
    if (existing) {
      if (existing.emailAddress.trim().toLowerCase() !== incoming.emailAddress.toLowerCase()) {
        throw new EasyEmailError(
          "LEGACY_IMPORT_CONFLICT",
          `Existing mailbox session ${incoming.id} conflicts with legacy temp_mailbox address.`,
        );
      }
      skippedCount += 1;
      continue;
    }
    existingSessions.push(incoming);
    byId.set(incoming.id, incoming);
    importedCount += 1;
  }

  root.sessions = existingSessions;
  writeFileSync(stateFilePath, JSON.stringify(root, null, 2), "utf8");
  return { importedCount, skippedCount };
}

export async function importLegacyEasyEmailAmDatabase(
  options: LegacyFullImportOptions,
): Promise<LegacyFullImportResult> {
  const nowFn = options.now ?? (() => new Date());
  const resolvedTarget = resolve(options.targetDatabasePath);
  const resolvedStatePath = options.targetStateFilePath
    ? resolve(options.targetStateFilePath)
    : undefined;

  if (isRelationalDatabaseOpen(resolvedTarget)) {
    throw new EasyEmailError(
      "LEGACY_IMPORT_TARGET_OPEN",
      "Close the EasyEmail relational database before running the legacy database importer.",
    );
  }
  if (resolvedStatePath && resolvedStatePath === resolve(options.sourceDatabasePath)) {
    throw new EasyEmailError(
      "LEGACY_IMPORT_INVALID_PATH",
      "Legacy source database and target state snapshot must not share a file.",
    );
  }

  const sourceBackup = prepareLegacyEasyEmailAmSourceSnapshot({
    sourceDatabasePath: options.sourceDatabasePath,
    targetDatabasePath: resolvedTarget,
    backupRootDirectory: options.backupDirectory,
    now: nowFn(),
    requireAllFoundationTables: options.requireAllFoundationTables ?? true,
  });

  const existingTables = new Set(sourceBackup.existingTables);
  const snapshotReader = new DatabaseSync(sourceBackup.snapshotDatabasePath, { readOnly: true });
  let mappedAccountsResult: Awaited<ReturnType<typeof readAndMapLegacyAccounts>>;
  let mappedCatalog: ReturnType<typeof readAndMapLegacyCatalogDomains>;
  let mappedActivity: ReturnType<typeof readAndMapLegacyMailActivityDomains>;
  try {
    mappedAccountsResult = await readAndMapLegacyAccounts(snapshotReader, options.vaultExistenceCheck);
    const accountsById = new Map(mappedAccountsResult.accounts.map((acct) => [acct.id, acct]));
    const importedAccountIds = new Set(accountsById.keys());
    mappedCatalog = readAndMapLegacyCatalogDomains(
      snapshotReader,
      existingTables,
      importedAccountIds,
      options.defaultHostId ?? "legacy-easyemailam-host",
    );
    mappedActivity = readAndMapLegacyMailActivityDomains(
      snapshotReader,
      existingTables,
      accountsById,
    );
  } finally {
    snapshotReader.close();
  }

  const nowDate = nowFn();
  const targetExisted = existsSync(resolvedTarget);
  const targetPreImportBackupPath = targetExisted
    ? createTargetPreImportBackup(resolvedTarget, nowDate)
    : undefined;

  const stateExisted = resolvedStatePath ? existsSync(resolvedStatePath) : false;
  let targetStateBackupPath: string | undefined;
  if (resolvedStatePath && stateExisted) {
    targetStateBackupPath = `${resolvedStatePath}.before-legacy-full-import-${nowDate.toISOString().replaceAll(":", "-")}-${randomUUID()}.bak`;
    copyFileSync(resolvedStatePath, targetStateBackupPath);
  }

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
    let importedTempSessionCount = 0;
    let skippedTempSessionCount = 0;
    if (resolvedStatePath && mappedCatalog.tempSessions.length > 0) {
      const merged = mergeTempSessionsIntoStateFile(resolvedStatePath, mappedCatalog.tempSessions);
      importedTempSessionCount = merged.importedCount;
      skippedTempSessionCount = merged.skippedCount;
    }

    const importedAt = nowFn().toISOString();
    const receiptId = `impr_v2_${randomUUID()}`;
    const writeResult = writeLegacyDomainsIntoTargetTransaction({
      targetDb,
      accounts: mappedAccountsResult.accounts,
      catalog: mappedCatalog,
      activity: mappedActivity,
      receiptId,
      importerVersion: LEGACY_FULL_IMPORTER_VERSION,
      sourceSha256: sourceBackup.sourceSha256,
      sourceSchemaVersion: sourceBackup.maxMigrationVersion,
      sourceAccountCount: sourceBackup.sourceAccountCount,
      sourceCredentialRefCount: sourceBackup.sourceCredentialRefCount,
      sourceTableRowCounts: sourceBackup.sourceTableRowCounts,
      importedTempSessionCount,
      skippedTempSessionCount,
      importedAt,
      beforeCommitHook: options.beforeCommitHook,
    });

    const integrityRow = targetDb.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    } | undefined;
    if (integrityRow?.integrity_check !== "ok") {
      throw new EasyEmailError(
        "LEGACY_IMPORT_VERIFICATION_FAILED",
        "Target relational database failed post-commit integrity_check.",
      );
    }

    closeTarget();
    assertLegacySourceUnchanged(sourceBackup);

    return {
      receipt: {
        id: receiptId,
        importerVersion: LEGACY_FULL_IMPORTER_VERSION,
        domain: "full_database",
        sourceSha256: sourceBackup.sourceSha256,
        sourceSchemaVersion: sourceBackup.maxMigrationVersion,
        sourceTableRowCounts: sourceBackup.sourceTableRowCounts,
        importedCounts: writeResult.importedCounts,
        skippedExistingCounts: writeResult.skippedExistingCounts,
        reauthRequiredCount: writeResult.reauthRequiredCount,
        queueStatusSummary: writeResult.queueStatusSummary,
        verifiedMessageSamples: writeResult.verifiedMessageSamples,
        importedAt,
      },
      sourceBackupDirectory: sourceBackup.snapshotDirectory,
      targetPreImportBackupPath,
      targetStateBackupPath,
      skippedAnonymousCount: mappedAccountsResult.skippedAnonymousCount,
    };
  } catch (error) {
    closeTarget();
    if (targetExisted && targetPreImportBackupPath) {
      restoreRelationalDatabaseBackup(resolvedTarget, targetPreImportBackupPath);
    } else if (!targetExisted) {
      cleanupNewTargetTrio(resolvedTarget);
    }
    if (resolvedStatePath) {
      if (stateExisted && targetStateBackupPath) {
        copyFileSync(targetStateBackupPath, resolvedStatePath);
      } else if (!stateExisted) {
        rmSync(resolvedStatePath, { force: true });
      }
    }
    assertLegacySourceUnchanged(sourceBackup);
    throw error;
  }
}
