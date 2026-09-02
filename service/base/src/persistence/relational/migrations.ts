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
  {
    version: 2,
    name: "mail-taxonomy-items",
    sql: `
CREATE TABLE mail_taxonomy_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('folder', 'label')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  parent_id TEXT REFERENCES mail_taxonomy_items(id) ON DELETE SET NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0 CHECK(system IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, normalized_name)
);

CREATE INDEX idx_mail_taxonomy_kind_sort
ON mail_taxonomy_items(kind, sort_order, name COLLATE NOCASE, id);

CREATE INDEX idx_mail_taxonomy_kind_parent_sort
ON mail_taxonomy_items(kind, parent_id, sort_order, name COLLATE NOCASE, id);
    `,
  },
  {
    version: 3,
    name: "mail-accounts",
    sql: `
CREATE TABLE mail_accounts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('normal', 'agent', 'system')),
  kind TEXT NOT NULL CHECK(kind IN ('normal_long_lived', 'normal_upgraded_temp', 'anonymous_virtual', 'agent_owned')),
  display_name TEXT NOT NULL,
  primary_address TEXT,
  provider_label TEXT,
  status TEXT NOT NULL CHECK(status IN ('ready', 'configuring', 'syncing', 'degraded', 'disabled', 'history_only', 'deleted')),
  auth_status TEXT NOT NULL CHECK(auth_status IN ('not_required', 'valid', 'expired', 'invalid', 'missing', 'refreshing', 'reauthorization_required')),
  receive_status TEXT NOT NULL CHECK(receive_status IN ('enabled', 'syncing', 'backoff', 'auth_failed', 'provider_unavailable', 'expired', 'disabled', 'unsupported')),
  send_status TEXT NOT NULL CHECK(send_status IN ('enabled', 'sending', 'queued_only', 'auth_failed', 'smtp_unavailable', 'rate_limited', 'disabled', 'unsupported')),
  listed_in_all_accounts INTEGER NOT NULL CHECK(listed_in_all_accounts IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK(
    (kind IN ('normal_long_lived', 'normal_upgraded_temp') AND scope = 'normal')
    OR (kind = 'agent_owned' AND scope = 'agent')
    OR (kind = 'anonymous_virtual' AND scope = 'system')
  ),
  CHECK(
    (kind = 'anonymous_virtual' AND primary_address IS NULL AND listed_in_all_accounts = 1)
    OR (kind != 'anonymous_virtual' AND primary_address IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_mail_accounts_live_address
ON mail_accounts(lower(primary_address))
WHERE primary_address IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX idx_mail_accounts_anonymous_virtual
ON mail_accounts(kind)
WHERE kind = 'anonymous_virtual' AND deleted_at IS NULL;

CREATE INDEX idx_mail_accounts_scope_created
ON mail_accounts(scope, created_at, id)
WHERE deleted_at IS NULL;

CREATE TABLE mail_account_credential_refs (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL,
  secret_backend TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  credential_kind TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'missing', 'invalid', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  FOREIGN KEY(owner_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
  UNIQUE(owner_account_id, secret_key),
  CONSTRAINT idx_mail_account_credential_refs_secret UNIQUE(secret_backend, secret_key)
);

CREATE INDEX idx_mail_account_credential_refs_owner
ON mail_account_credential_refs(owner_account_id, created_at, id);
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
