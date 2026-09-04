import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import { isRelationalDatabaseOpen } from "./database-bootstrap.js";

export function resolveRelationalDatabasePath(snapshotDatabasePath: string): string {
  return resolve(dirname(snapshotDatabasePath), "easy-email-relational.sqlite3");
}

export interface RelationalDatabaseRestoreResult {
  databasePath: string;
  backupPath: string;
  previousDatabasePath?: string;
  previousWalPath?: string;
  previousShmPath?: string;
}

function validateRelationalBackup(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    } | undefined;
    const ledger = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get() as { present: number } | undefined;
    if (integrity?.integrity_check !== "ok" || ledger?.present !== 1) {
      throw new Error("Backup is not an intact EasyEmail relational database.");
    }
  } finally {
    database.close();
  }
}

export function restoreRelationalDatabaseBackup(
  databasePath: string,
  backupPath: string,
): RelationalDatabaseRestoreResult {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedBackupPath = resolve(backupPath);
  if (!existsSync(resolvedBackupPath)) {
    throw new Error(`Relational database backup does not exist: ${backupPath}`);
  }
  if (isRelationalDatabaseOpen(resolvedDatabasePath)) {
    throw new EasyEmailError(
      "RELATIONAL_RESTORE_TARGET_OPEN",
      "Close the EasyEmail relational database before restoring a backup.",
    );
  }

  mkdirSync(dirname(resolvedDatabasePath), { recursive: true });
  const restoreId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const preparedPath = `${resolvedDatabasePath}.restore-${restoreId}.tmp`;
  copyFileSync(resolvedBackupPath, preparedPath);
  try {
    validateRelationalBackup(preparedPath);
    const moved: Array<{ source: string; recovery: string; key: keyof RelationalDatabaseRestoreResult }> = [];
    for (const [source, key] of [
      [resolvedDatabasePath, "previousDatabasePath"],
      [`${resolvedDatabasePath}-wal`, "previousWalPath"],
      [`${resolvedDatabasePath}-shm`, "previousShmPath"],
    ] as const) {
      if (!existsSync(source)) continue;
      const recovery = `${source}.before-restore-${restoreId}`;
      renameSync(source, recovery);
      moved.push({ source, recovery, key });
    }

    try {
      renameSync(preparedPath, resolvedDatabasePath);
    } catch (error) {
      for (const item of moved.reverse()) {
        renameSync(item.recovery, item.source);
      }
      throw error;
    }

    const result: RelationalDatabaseRestoreResult = {
      databasePath: resolvedDatabasePath,
      backupPath: resolvedBackupPath,
    };
    for (const item of moved) result[item.key] = item.recovery;
    return result;
  } finally {
    rmSync(preparedPath, { force: true });
  }
}
