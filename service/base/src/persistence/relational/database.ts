import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EasyEmailError } from "../../domain/errors.js";
import type {
  MailAccount,
  MailAccountRepository,
  MailAccountRepositoryCreateInput,
  MailAccountRepositoryListQuery,
  MailAccountRepositoryListResult,
  MailAccountRepositoryUpdateInput,
  MailCredentialRef,
} from "../../domain/account.js";
import type {
  Contact,
  ContactRepository,
  ContactRepositoryCreateInput,
  ContactRepositoryListQuery,
  ContactRepositoryListResult,
  ContactRepositoryUpdateInput,
} from "../../domain/contact.js";
import type {
  MailTaxonomyItem,
  MailTaxonomyRepository,
  MailTaxonomyRepositoryListQuery,
  MailTaxonomyRepositoryListResult,
  MailTaxonomyUpdateInput,
  MailTaxonomyUpsertInput,
} from "../../domain/mail-taxonomy.js";
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

interface ContactSqlRow {
  id: string;
  display_name: string;
  email_address: string;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MailTaxonomySqlRow {
  id: string;
  kind: "folder" | "label";
  name: string;
  normalized_name: string;
  parent_id: string | null;
  color: string;
  sort_order: number;
  system: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MailAccountSqlRow {
  id: string;
  scope: MailAccount["scope"];
  kind: MailAccount["kind"];
  display_name: string;
  primary_address: string | null;
  provider_label: string | null;
  status: MailAccount["status"];
  auth_status: MailAccount["authStatus"];
  receive_status: MailAccount["receiveStatus"];
  send_status: MailAccount["sendStatus"];
  listed_in_all_accounts: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MailCredentialRefSqlRow {
  id: string;
  owner_account_id: string;
  secret_backend: string;
  secret_key: string;
  credential_kind: string;
  auth_method: string;
  status: MailCredentialRef["status"];
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
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

function mapContact(row: ContactSqlRow): Contact {
  return {
    id: row.id,
    displayName: row.display_name,
    emailAddress: row.email_address,
    note: row.note ?? undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMailTaxonomyItem(row: MailTaxonomySqlRow): MailTaxonomyItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    parentId: row.parent_id ?? undefined,
    color: row.color,
    sortOrder: row.sort_order,
    system: row.system === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMailCredentialRef(row: MailCredentialRefSqlRow): MailCredentialRef {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    secretBackend: row.secret_backend,
    secretKey: row.secret_key,
    credentialKind: row.credential_kind,
    authMethod: row.auth_method,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at ?? undefined,
  };
}

function mapMailAccount(row: MailAccountSqlRow, credentialRefs: MailCredentialRef[]): MailAccount {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    displayName: row.display_name,
    primaryAddress: row.primary_address ?? undefined,
    providerLabel: row.provider_label ?? undefined,
    status: row.status,
    authStatus: row.auth_status,
    receiveStatus: row.receive_status,
    sendStatus: row.send_status,
    listedInAllAccounts: row.listed_in_all_accounts === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    credentialRefs,
  };
}

function readContactRow(value: unknown): ContactSqlRow | undefined {
  return value as ContactSqlRow | undefined;
}

function selectContactById(database: DatabaseSync, id: string): Contact | undefined {
  const row = readContactRow(database.prepare(`
    SELECT id, display_name, email_address, note, version, created_at, updated_at
    FROM contacts
    WHERE id = ?
  `).get(id));
  return row ? mapContact(row) : undefined;
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

export class SqliteRelationalDatabase implements ContactRepository, MailTaxonomyRepository, MailAccountRepository {
  private readonly database: DatabaseSync;
  private readonly trackedDatabasePath?: string;
  private closed = false;
  public readonly backupPath?: string;

  public constructor(options: SqliteRelationalDatabaseOptions) {
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

    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

    try {
      const prepared = prepareRelationalMigrations(migrations);
      const hasLedger = databaseHasMigrationLedger(this.database);
      const appliedVersions = hasLedger
        ? new Set((this.database.prepare(
          "SELECT version FROM schema_migrations WHERE result = 'applied'",
        ).all() as unknown as Array<{ version: number }>).map((row) => row.version))
        : new Set<number>();
      const pending = prepared.filter((migration) => !appliedVersions.has(migration.version));
      if (existed && pending.length > 0) {
        const targetVersion = pending.at(-1)?.version ?? 0;
        this.backupPath = migrationBackupPath(databasePath, targetVersion, now());
        this.database.exec(`VACUUM INTO ${quoteSqlString(this.backupPath)}`);
      }
      applyMigrations(this.database, migrations, now);
      if (databaseHasMailAccounts(this.database)) {
        ensureAnonymousVirtualAccount(this.database, now().toISOString());
      }
      if (!isMemory) {
        this.trackedDatabasePath = databasePath;
        OPEN_RELATIONAL_DATABASES.add(databasePath);
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  public async listContacts(query: ContactRepositoryListQuery): Promise<ContactRepositoryListResult> {
    const params: Array<string | number> = [];
    let where = "";
    if (query.after) {
      where = `WHERE (
        lower(display_name) > ?
        OR (lower(display_name) = ? AND lower(email_address) > ?)
        OR (lower(display_name) = ? AND lower(email_address) = ? AND id > ?)
      )`;
      params.push(
        query.after.displayNameKey,
        query.after.displayNameKey,
        query.after.emailAddressKey,
        query.after.displayNameKey,
        query.after.emailAddressKey,
        query.after.id,
      );
    }
    params.push(query.limit + 1);
    const rows = this.database.prepare(`
      SELECT id, display_name, email_address, note, version, created_at, updated_at
      FROM contacts
      ${where}
      ORDER BY display_name COLLATE NOCASE ASC, email_address COLLATE NOCASE ASC, id ASC
      LIMIT ?
    `).all(...params) as unknown as ContactSqlRow[];
    return {
      contacts: rows.slice(0, query.limit).map(mapContact),
      hasMore: rows.length > query.limit,
    };
  }

  public async getContact(id: string): Promise<Contact | undefined> {
    return selectContactById(this.database, id);
  }

  public async createContact(input: ContactRepositoryCreateInput): Promise<Contact> {
    this.database.prepare(`
      INSERT INTO contacts (
        id, display_name, email_address, note, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(email_address) DO UPDATE SET
        display_name = excluded.display_name,
        note = excluded.note,
        version = contacts.version + 1,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.displayName,
      input.emailAddress,
      input.note ?? null,
      input.now,
      input.now,
    );
    const row = readContactRow(this.database.prepare(`
      SELECT id, display_name, email_address, note, version, created_at, updated_at
      FROM contacts
      WHERE email_address = ?
    `).get(input.emailAddress));
    if (!row) throw new Error("Contact upsert did not return a row.");
    return mapContact(row);
  }

  public async updateContact(input: ContactRepositoryUpdateInput): Promise<Contact | undefined> {
    const row = readContactRow(this.database.prepare(`
      UPDATE contacts
      SET display_name = ?, email_address = ?, note = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
      RETURNING id, display_name, email_address, note, version, created_at, updated_at
    `).get(
      input.displayName,
      input.emailAddress,
      input.note ?? null,
      input.now,
      input.id,
      input.expectedVersion,
    ));
    return row ? mapContact(row) : undefined;
  }

  public async deleteContact(id: string, expectedVersion: number): Promise<boolean> {
    const result = this.database.prepare(
      "DELETE FROM contacts WHERE id = ? AND version = ?",
    ).run(id, expectedVersion);
    return result.changes === 1;
  }

  public async listMailTaxonomyItems(
    query: MailTaxonomyRepositoryListQuery,
  ): Promise<MailTaxonomyRepositoryListResult> {
    const params: Array<string | number> = [query.kind];
    let where = "WHERE kind = ?";
    if (query.after) {
      where += ` AND (
        sort_order > ?
        OR (sort_order = ? AND lower(name) > ?)
        OR (sort_order = ? AND lower(name) = ? AND id > ?)
      )`;
      params.push(
        query.after.sortOrder,
        query.after.sortOrder,
        query.after.nameKey,
        query.after.sortOrder,
        query.after.nameKey,
        query.after.id,
      );
    }
    params.push(query.limit + 1);
    const rows = this.database.prepare(`
      SELECT id, kind, name, normalized_name, parent_id, color, sort_order,
             system, version, created_at, updated_at
      FROM mail_taxonomy_items
      ${where}
      ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC
      LIMIT ?
    `).all(...params) as unknown as MailTaxonomySqlRow[];
    return {
      items: rows.slice(0, query.limit).map(mapMailTaxonomyItem),
      hasMore: rows.length > query.limit,
    };
  }

  public async getMailTaxonomyItem(id: string): Promise<MailTaxonomyItem | undefined> {
    const row = this.database.prepare(`
      SELECT id, kind, name, normalized_name, parent_id, color, sort_order,
             system, version, created_at, updated_at
      FROM mail_taxonomy_items
      WHERE id = ?
    `).get(id) as unknown as MailTaxonomySqlRow | undefined;
    return row ? mapMailTaxonomyItem(row) : undefined;
  }

  public async upsertMailTaxonomyItem(input: MailTaxonomyUpsertInput): Promise<MailTaxonomyItem> {
    const existing = this.database.prepare(
      "SELECT id FROM mail_taxonomy_items WHERE kind = ? AND normalized_name = ?",
    ).get(input.kind, input.normalizedName) as { id: string } | undefined;
    const id = existing?.id ?? input.id;
    const sortOrder = existing
      ? undefined
      : (this.database.prepare(
        "SELECT COALESCE(MAX(sort_order), 0) + 10 AS value FROM mail_taxonomy_items WHERE kind = ?",
      ).get(input.kind) as { value: number }).value;
    this.database.prepare(`
      INSERT INTO mail_taxonomy_items (
        id, kind, name, normalized_name, parent_id, color, sort_order, system,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
      ON CONFLICT(kind, normalized_name) DO UPDATE SET
        name = excluded.name,
        parent_id = excluded.parent_id,
        color = excluded.color,
        version = mail_taxonomy_items.version + 1,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.kind,
      input.name,
      input.normalizedName,
      input.parentId ?? null,
      input.color,
      sortOrder ?? 0,
      input.now,
      input.now,
    );
    const result = await this.getMailTaxonomyItem(id);
    if (!result) throw new Error("Mail taxonomy upsert did not return a row.");
    return result;
  }

  public async updateMailTaxonomyItem(
    input: MailTaxonomyUpdateInput,
  ): Promise<MailTaxonomyItem | undefined> {
    const row = this.database.prepare(`
      UPDATE mail_taxonomy_items
      SET name = ?, normalized_name = ?, parent_id = ?, color = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
      RETURNING id, kind, name, normalized_name, parent_id, color, sort_order,
                system, version, created_at, updated_at
    `).get(
      input.name,
      input.normalizedName,
      input.parentId ?? null,
      input.color,
      input.now,
      input.id,
      input.expectedVersion,
    ) as unknown as MailTaxonomySqlRow | undefined;
    return row ? mapMailTaxonomyItem(row) : undefined;
  }

  public async deleteMailTaxonomyItem(id: string, expectedVersion: number): Promise<boolean> {
    const result = this.database.prepare(
      "DELETE FROM mail_taxonomy_items WHERE id = ? AND version = ? AND system = 0",
    ).run(id, expectedVersion);
    return result.changes === 1;
  }

  private async listMailCredentialRefs(accountId: string): Promise<MailCredentialRef[]> {
    const rows = this.database.prepare(`
      SELECT id, owner_account_id, secret_backend, secret_key, credential_kind,
             auth_method, status, created_at, updated_at, last_verified_at
      FROM mail_account_credential_refs
      WHERE owner_account_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(accountId) as unknown as MailCredentialRefSqlRow[];
    return rows.map(mapMailCredentialRef);
  }

  private async mapMailAccountRow(row: MailAccountSqlRow): Promise<MailAccount> {
    return mapMailAccount(row, await this.listMailCredentialRefs(row.id));
  }

  public async listMailAccounts(
    query: MailAccountRepositoryListQuery,
  ): Promise<MailAccountRepositoryListResult> {
    const params: Array<string | number> = [];
    const conditions = ["deleted_at IS NULL"];
    if (query.scope) {
      if (query.scope === "normal") {
        conditions.push("listed_in_all_accounts = 1 AND (scope = 'normal' OR kind = 'anonymous_virtual')");
      } else {
        conditions.push("scope = ?");
        params.push(query.scope);
      }
    }
    if (query.after) {
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(query.after.createdAt, query.after.createdAt, query.after.id);
    }
    params.push(query.limit + 1);
    const rows = this.database.prepare(`
      SELECT id, scope, kind, display_name, primary_address, provider_label,
             status, auth_status, receive_status, send_status,
             listed_in_all_accounts, version, created_at, updated_at
      FROM mail_accounts
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...params) as unknown as MailAccountSqlRow[];
    const accounts = [];
    for (const row of rows.slice(0, query.limit)) {
      accounts.push(await this.mapMailAccountRow(row));
    }
    return {
      accounts,
      hasMore: rows.length > query.limit,
    };
  }

  public async getMailAccount(id: string): Promise<MailAccount | undefined> {
    const row = this.database.prepare(`
      SELECT id, scope, kind, display_name, primary_address, provider_label,
             status, auth_status, receive_status, send_status,
             listed_in_all_accounts, version, created_at, updated_at
      FROM mail_accounts
      WHERE id = ? AND deleted_at IS NULL
    `).get(id) as unknown as MailAccountSqlRow | undefined;
    return row ? this.mapMailAccountRow(row) : undefined;
  }

  public async createMailAccount(input: MailAccountRepositoryCreateInput): Promise<MailAccount> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO mail_accounts (
          id, scope, kind, display_name, primary_address, provider_label,
          status, auth_status, receive_status, send_status,
          listed_in_all_accounts, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.scope,
        input.kind,
        input.displayName,
        input.primaryAddress ?? null,
        input.providerLabel ?? null,
        input.status,
        input.authStatus,
        input.receiveStatus,
        input.sendStatus,
        input.listedInAllAccounts ? 1 : 0,
        input.now,
        input.now,
      );
      for (const ref of input.credentialRefs) {
        this.database.prepare(`
          INSERT INTO mail_account_credential_refs (
            id, owner_account_id, secret_backend, secret_key, credential_kind,
            auth_method, status, created_at, updated_at, last_verified_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'missing', ?, ?, NULL)
        `).run(
          `cred_v1_${randomUUID()}`,
          input.id,
          ref.secretBackend,
          ref.secretKey,
          ref.credentialKind,
          ref.authMethod,
          input.now,
          input.now,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const account = await this.getMailAccount(input.id);
    if (!account) throw new Error("Mail account create did not return a row.");
    return account;
  }

  public async updateMailAccount(
    input: MailAccountRepositoryUpdateInput,
  ): Promise<MailAccount | undefined> {
    const row = this.database.prepare(`
      UPDATE mail_accounts
      SET display_name = ?, provider_label = ?, listed_in_all_accounts = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL
      RETURNING id, scope, kind, display_name, primary_address, provider_label,
                status, auth_status, receive_status, send_status,
                listed_in_all_accounts, version, created_at, updated_at
    `).get(
      input.displayName,
      input.providerLabel ?? null,
      input.listedInAllAccounts ? 1 : 0,
      input.now,
      input.id,
      input.expectedVersion,
    ) as unknown as MailAccountSqlRow | undefined;
    return row ? this.mapMailAccountRow(row) : undefined;
  }

  public async disableMailAccount(
    id: string,
    expectedVersion: number,
    now: string,
  ): Promise<MailAccount | undefined> {
    const row = this.database.prepare(`
      UPDATE mail_accounts
      SET status = 'disabled', receive_status = 'disabled', send_status = 'disabled',
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL
      RETURNING id, scope, kind, display_name, primary_address, provider_label,
                status, auth_status, receive_status, send_status,
                listed_in_all_accounts, version, created_at, updated_at
    `).get(now, id, expectedVersion) as unknown as MailAccountSqlRow | undefined;
    return row ? this.mapMailAccountRow(row) : undefined;
  }

  public async deleteMailAccount(id: string, expectedVersion: number, now: string): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE mail_accounts
      SET status = 'deleted', deleted_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL
    `).run(now, now, id, expectedVersion);
    return result.changes === 1;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } finally {
      if (this.trackedDatabasePath) {
        OPEN_RELATIONAL_DATABASES.delete(this.trackedDatabasePath);
      }
    }
  }
}

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
  if (OPEN_RELATIONAL_DATABASES.has(resolvedDatabasePath)) {
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
