import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import {
  RELATIONAL_MIGRATIONS,
  prepareRelationalMigrations,
  type RelationalMigration,
} from "./migrations.js";

const MIGRATION_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT NOT NULL CHECK(result IN ('running', 'applied', 'failed')),
  error_code TEXT
);
`;

const OPEN_RELATIONAL_DATABASES = new Set<string>();

interface MigrationLedgerRow {
  version: number;
  name: string;
  checksum: string;
  result: string;
}

export interface SqliteRelationalDatabaseOptions {
  databasePath: string;
  migrations?: readonly RelationalMigration[];
  now?: () => Date;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function migrationBackupPath(databasePath: string, targetVersion: number, now: Date): string {
  const timestamp = now.toISOString().replaceAll(":", "-");
  return `${databasePath}.before-v${targetVersion}-${timestamp}-${randomUUID()}.bak`;
}

function databaseHasMigrationLedger(database: DatabaseSync): boolean {
  const row = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() as { present: number } | undefined;
  return row?.present === 1;
}

function databaseHasMailAccounts(database: DatabaseSync): boolean {
  const row = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'mail_accounts'",
  ).get() as { present: number } | undefined;
  return row?.present === 1;
}

function ensureAnonymousVirtualAccount(database: DatabaseSync, now: string): void {
  database.prepare(`
    INSERT INTO mail_accounts (
      id, scope, kind, display_name, primary_address, provider_label,
      status, auth_status, receive_status, send_status,
      listed_in_all_accounts, version, created_at, updated_at, deleted_at
    ) VALUES (
      'acct_anonymous_virtual', 'system', 'anonymous_virtual', 'Anonymous Mailbox', NULL, NULL,
      'ready', 'not_required', 'enabled', 'unsupported', 1, 1, ?, ?, NULL
    )
    ON CONFLICT(id) DO NOTHING
  `).run(now, now);
}

function applyMigrations(
  database: DatabaseSync,
  migrations: readonly RelationalMigration[],
  now: () => Date,
): void {
  const prepared = prepareRelationalMigrations(migrations);
  database.exec(MIGRATION_LEDGER_SQL);
  const rows = database.prepare(
    "SELECT version, name, checksum, result FROM schema_migrations ORDER BY version ASC",
  ).all() as unknown as MigrationLedgerRow[];
  const knownByVersion = new Map(prepared.map((migration) => [migration.version, migration]));

  for (const row of rows) {
    const migration = knownByVersion.get(row.version);
    if (!migration) {
      throw new EasyEmailError(
        "RELATIONAL_SCHEMA_NEWER",
        `Relational schema version ${row.version} is not supported by this EasyEmail build.`,
      );
    }
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new EasyEmailError(
        "RELATIONAL_MIGRATION_CHECKSUM_MISMATCH",
        `Relational migration ${row.version} does not match this EasyEmail build.`,
      );
    }
  }

  for (const migration of prepared) {
    const current = rows.find((row) => row.version === migration.version);
    if (current?.result === "applied") continue;

    const startedAt = now().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (
        version, name, checksum, started_at, finished_at, result, error_code
      ) VALUES (?, ?, ?, ?, NULL, 'running', NULL)
      ON CONFLICT(version) DO UPDATE SET
        name = excluded.name,
        checksum = excluded.checksum,
        started_at = excluded.started_at,
        finished_at = NULL,
        result = 'running',
        error_code = NULL
    `).run(migration.version, migration.name, migration.checksum, startedAt);

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare(`
        UPDATE schema_migrations
        SET finished_at = ?, result = 'applied', error_code = NULL
        WHERE version = ?
      `).run(now().toISOString(), migration.version);
      database.exec("COMMIT");
    } catch {
      database.exec("ROLLBACK");
      database.prepare(`
        UPDATE schema_migrations
        SET finished_at = ?, result = 'failed', error_code = 'RELATIONAL_MIGRATION_FAILED'
        WHERE version = ?
      `).run(now().toISOString(), migration.version);
      throw new EasyEmailError(
        "RELATIONAL_MIGRATION_FAILED",
        `Relational migration ${migration.version} failed and was rolled back.`,
      );
    }
  }
}

export interface OpenedRelationalDatabase {
  database: DatabaseSync;
  backupPath?: string;
  trackedDatabasePath?: string;
}

export function openRelationalDatabase(
  options: SqliteRelationalDatabaseOptions,
): OpenedRelationalDatabase {
  const migrations = options.migrations ?? RELATIONAL_MIGRATIONS;
  const now = options.now ?? (() => new Date());
  const isMemory = options.databasePath === ":memory:";
  const databasePath = isMemory ? options.databasePath : resolve(options.databasePath);
  const existed = !isMemory && existsSync(databasePath);
  if (!isMemory) {
    if (OPEN_RELATIONAL_DATABASES.has(databasePath)) {
      throw new EasyEmailError(
        "RELATIONAL_DATABASE_ALREADY_OPEN",
        "The relational database is already open in this EasyEmail process.",
      );
    }
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  try {
    const prepared = prepareRelationalMigrations(migrations);
    const hasLedger = databaseHasMigrationLedger(database);
    const appliedVersions = hasLedger
      ? new Set((database.prepare(
        "SELECT version FROM schema_migrations WHERE result = 'applied'",
      ).all() as unknown as Array<{ version: number }>).map((row) => row.version))
      : new Set<number>();
    const pending = prepared.filter((migration) => !appliedVersions.has(migration.version));
    let backupPath: string | undefined;
    if (existed && pending.length > 0) {
      const targetVersion = pending.at(-1)?.version ?? 0;
      backupPath = migrationBackupPath(databasePath, targetVersion, now());
      database.exec("VACUUM INTO " + quoteSqlString(backupPath));
    }
    applyMigrations(database, migrations, now);
    if (databaseHasMailAccounts(database)) {
      ensureAnonymousVirtualAccount(database, now().toISOString());
    }
    if (!isMemory) {
      OPEN_RELATIONAL_DATABASES.add(databasePath);
    }
    return {
      database,
      backupPath,
      trackedDatabasePath: isMemory ? undefined : databasePath,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function releaseRelationalDatabasePath(databasePath: string | undefined): void {
  if (databasePath) OPEN_RELATIONAL_DATABASES.delete(databasePath);
}

export function isRelationalDatabaseOpen(databasePath: string): boolean {
  return OPEN_RELATIONAL_DATABASES.has(databasePath);
}
