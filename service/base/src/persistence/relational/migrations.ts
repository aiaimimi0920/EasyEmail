import { createHash } from "node:crypto";

export interface RelationalMigration {
  version: number;
  name: string;
  sql: string;
}

export interface PreparedRelationalMigration extends RelationalMigration {
  checksum: string;
}

export const RELATIONAL_MIGRATIONS: readonly RelationalMigration[] = [
  {
    version: 1,
    name: "contacts",
    sql: `
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email_address TEXT NOT NULL UNIQUE,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_contacts_display_name
ON contacts(display_name COLLATE NOCASE, email_address COLLATE NOCASE, id);
`,
  },
] as const;

export const EASY_EMAIL_RELATIONAL_SCHEMA_VERSION = RELATIONAL_MIGRATIONS.at(-1)?.version ?? 0;

export function prepareRelationalMigrations(
  migrations: readonly RelationalMigration[] = RELATIONAL_MIGRATIONS,
): PreparedRelationalMigration[] {
  let previousVersion = 0;
  return migrations.map((migration) => {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error("Relational migrations must use strictly increasing positive integer versions.");
    }
    previousVersion = migration.version;
    return {
      ...migration,
      checksum: createHash("sha256").update(migration.sql, "utf8").digest("hex"),
    };
  });
}
