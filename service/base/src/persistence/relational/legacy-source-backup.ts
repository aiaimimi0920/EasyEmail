import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";

const MAX_SUPPORTED_LEGACY_SCHEMA_VERSION = 10;
const REQUIRED_LEGACY_TABLES = [
  "schema_migrations",
  "accounts",
  "mailbox_sources",
  "credential_refs",
] as const;

export interface LegacySourceBackupArtifacts {
  sourceDatabasePath: string;
  sourceSha256: string;
  sourceWalSha256?: string;
  snapshotDirectory: string;
  snapshotDatabasePath: string;
  maxMigrationVersion: number;
  sourceAccountCount: number;
  sourceCredentialRefCount: number;
}

export function computeFileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function assertLegacySourceUnchanged(artifacts: LegacySourceBackupArtifacts): void {
  const currentSha = computeFileSha256(artifacts.sourceDatabasePath);
  if (currentSha !== artifacts.sourceSha256) {
    throw new EasyEmailError(
      "LEGACY_SOURCE_MUTATED",
      "The legacy EasyEmailAM database changed unexpectedly during import.",
    );
  }
  const walPath = `${artifacts.sourceDatabasePath}-wal`;
  if (artifacts.sourceWalSha256 !== undefined) {
    if (!existsSync(walPath) || computeFileSha256(walPath) !== artifacts.sourceWalSha256) {
      throw new EasyEmailError(
        "LEGACY_SOURCE_MUTATED",
        "The legacy EasyEmailAM WAL file changed unexpectedly during import.",
      );
    }
  }
}

function validateLegacySnapshotDatabase(snapshotDatabasePath: string): {
  maxMigrationVersion: number;
  sourceAccountCount: number;
  sourceCredentialRefCount: number;
} {
  // Consolidate any copied WAL frames on the isolated snapshot copy only.
  const checkpointDb = new DatabaseSync(snapshotDatabasePath);
  try {
    checkpointDb.exec("PRAGMA busy_timeout = 5000;");
    if (existsSync(`${snapshotDatabasePath}-wal`)) {
      checkpointDb.exec("PRAGMA wal_checkpoint(PASSIVE);");
    }
  } finally {
    checkpointDb.close();
  }

  const database = new DatabaseSync(snapshotDatabasePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    } | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new EasyEmailError(
        "LEGACY_SOURCE_CORRUPT",
        "The legacy EasyEmailAM SQLite database failed integrity_check.",
      );
    }

    for (const table of REQUIRED_LEGACY_TABLES) {
      const present = database.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table) as { present?: number } | undefined;
      if (present?.present !== 1) {
        throw new EasyEmailError(
          "LEGACY_SOURCE_SCHEMA_UNSUPPORTED",
          `Legacy EasyEmailAM database is missing required table: ${table}.`,
        );
      }
    }

    const migrationRows = database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    ).all() as unknown as Array<{ version: number }>;
    if (migrationRows.length === 0) {
      throw new EasyEmailError(
        "LEGACY_SOURCE_SCHEMA_UNSUPPORTED",
        "Legacy EasyEmailAM database has an empty schema_migrations ledger.",
      );
    }
    let expectedVersion = 1;
    for (const row of migrationRows) {
      if (!Number.isSafeInteger(row.version) || row.version !== expectedVersion) {
        throw new EasyEmailError(
          "LEGACY_SOURCE_SCHEMA_UNSUPPORTED",
          "Legacy EasyEmailAM schema_migrations versions are non-contiguous or invalid.",
        );
      }
      expectedVersion += 1;
    }
    const maxMigrationVersion = migrationRows.at(-1)?.version ?? 0;
    if (maxMigrationVersion > MAX_SUPPORTED_LEGACY_SCHEMA_VERSION) {
      throw new EasyEmailError(
        "LEGACY_SOURCE_SCHEMA_NEWER",
        `Legacy EasyEmailAM schema version ${maxMigrationVersion} is newer than supported version ${MAX_SUPPORTED_LEGACY_SCHEMA_VERSION}.`,
      );
    }

    const accountCountRow = database.prepare("SELECT COUNT(*) AS count FROM accounts").get() as {
      count: number;
    };
    const credentialCountRow = database.prepare(
      "SELECT COUNT(*) AS count FROM credential_refs",
    ).get() as { count: number };

    return {
      maxMigrationVersion,
      sourceAccountCount: accountCountRow.count,
      sourceCredentialRefCount: credentialCountRow.count,
    };
  } finally {
    database.close();
  }
}

export function prepareLegacyEasyEmailAmSourceSnapshot(options: {
  sourceDatabasePath: string;
  targetDatabasePath: string;
  backupRootDirectory?: string;
  now?: Date;
}): LegacySourceBackupArtifacts {
  const resolvedSource = resolve(options.sourceDatabasePath);
  const resolvedTarget = resolve(options.targetDatabasePath);
  if (resolvedSource === resolvedTarget) {
    throw new EasyEmailError(
      "LEGACY_IMPORT_INVALID_PATH",
      "Legacy source database and relational target database must not share a file.",
    );
  }
  if (!existsSync(resolvedSource)) {
    throw new EasyEmailError(
      "LEGACY_SOURCE_NOT_FOUND",
      `Legacy EasyEmailAM database does not exist: ${options.sourceDatabasePath}`,
    );
  }

  const sourceSha256 = computeFileSha256(resolvedSource);
  const sourceWalPath = `${resolvedSource}-wal`;
  const sourceShmPath = `${resolvedSource}-shm`;
  const sourceWalSha256 = existsSync(sourceWalPath) ? computeFileSha256(sourceWalPath) : undefined;

  const timestamp = (options.now ?? new Date()).toISOString().replaceAll(":", "-");
  const backupRoot = resolve(options.backupRootDirectory ?? dirname(resolvedTarget));
  const snapshotDirectory = join(
    backupRoot,
    `legacy-easyemailam-backup-${timestamp}-${randomUUID()}`,
  );
  mkdirSync(snapshotDirectory, { recursive: true });
  const baseFileName = basename(resolvedSource);
  const snapshotDatabasePath = join(snapshotDirectory, baseFileName);

  try {
    copyFileSync(resolvedSource, snapshotDatabasePath);
    if (existsSync(sourceWalPath)) {
      copyFileSync(sourceWalPath, `${snapshotDatabasePath}-wal`);
    }
    if (existsSync(sourceShmPath)) {
      copyFileSync(sourceShmPath, `${snapshotDatabasePath}-shm`);
    }

    const validated = validateLegacySnapshotDatabase(snapshotDatabasePath);
    const artifacts: LegacySourceBackupArtifacts = {
      sourceDatabasePath: resolvedSource,
      sourceSha256,
      sourceWalSha256,
      snapshotDirectory,
      snapshotDatabasePath,
      ...validated,
    };
    assertLegacySourceUnchanged(artifacts);
    return artifacts;
  } catch (error) {
    rmSync(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
}
