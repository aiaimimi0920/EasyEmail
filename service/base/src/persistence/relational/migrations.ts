import { createHash } from "node:crypto";

import { MAIL_IMAP_SYNC_MIGRATION_SQL } from "./migrations-imap-sync.js";
import { MAIL_M7A_EXTENSIONS_MIGRATION_SQL } from "./migrations-m7a.js";
import { MAIL_M7B_AGENT_MIGRATION_SQL } from "./migrations-m7b.js";
import { MAIL_M7C_AVATARS_MIGRATION_SQL } from "./migrations-m7c.js";

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
  {
    version: 4,
    name: "mail-account-imap-profile",
    sql: `
ALTER TABLE mail_accounts ADD COLUMN imap_host TEXT CHECK(imap_host IS NULL OR (length(trim(imap_host)) >= 1 AND length(imap_host) <= 253));
ALTER TABLE mail_accounts ADD COLUMN imap_port INTEGER CHECK(imap_port IS NULL OR (imap_port >= 1 AND imap_port <= 65535));
ALTER TABLE mail_accounts ADD COLUMN imap_security TEXT CHECK(imap_security IS NULL OR imap_security IN ('tls', 'starttls'));
ALTER TABLE mail_accounts ADD COLUMN imap_username TEXT CHECK(imap_username IS NULL OR (length(trim(imap_username)) >= 1 AND length(imap_username) <= 320));

CREATE TRIGGER validate_mail_account_imap_profile_insert
BEFORE INSERT ON mail_accounts
WHEN NOT (
  (NEW.imap_host IS NULL AND NEW.imap_port IS NULL AND NEW.imap_security IS NULL AND NEW.imap_username IS NULL)
  OR (
    NEW.kind != 'anonymous_virtual'
    AND NEW.imap_host IS NOT NULL
    AND NEW.imap_port IS NOT NULL
    AND NEW.imap_security IS NOT NULL
    AND NEW.imap_username IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_MAIL_ACCOUNT_IMAP_PROFILE');
END;

CREATE TRIGGER validate_mail_account_imap_profile_update
BEFORE UPDATE OF kind, imap_host, imap_port, imap_security, imap_username ON mail_accounts
WHEN NOT (
  (NEW.imap_host IS NULL AND NEW.imap_port IS NULL AND NEW.imap_security IS NULL AND NEW.imap_username IS NULL)
  OR (
    NEW.kind != 'anonymous_virtual'
    AND NEW.imap_host IS NOT NULL
    AND NEW.imap_port IS NOT NULL
    AND NEW.imap_security IS NOT NULL
    AND NEW.imap_username IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_MAIL_ACCOUNT_IMAP_PROFILE');
END;
`,
  },
  {
    version: 5,
    name: "legacy-import-receipts",
    sql: `
CREATE TABLE legacy_import_receipts (
  id TEXT PRIMARY KEY,
  importer_version INTEGER NOT NULL CHECK(importer_version >= 1),
  domain TEXT NOT NULL CHECK(length(trim(domain)) >= 1 AND length(domain) <= 64),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  source_schema_version INTEGER NOT NULL CHECK(source_schema_version >= 1),
  source_account_count INTEGER NOT NULL CHECK(source_account_count >= 0),
  source_credential_ref_count INTEGER NOT NULL CHECK(source_credential_ref_count >= 0),
  imported_account_count INTEGER NOT NULL CHECK(imported_account_count >= 0),
  skipped_existing_count INTEGER NOT NULL CHECK(skipped_existing_count >= 0),
  reauth_required_count INTEGER NOT NULL CHECK(reauth_required_count >= 0),
  imported_at TEXT NOT NULL
);

CREATE INDEX idx_legacy_import_receipts_domain_time
ON legacy_import_receipts(domain, imported_at DESC, id);
`,
  },
  {
    version: 6,
    name: "mail-messages-and-verifications",
    sql: `
CREATE TABLE mail_messages (
  id TEXT PRIMARY KEY,
  rfc_message_id TEXT,
  thread_key TEXT,
  subject TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  snippet TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  body_cache_state TEXT NOT NULL CHECK(body_cache_state IN ('none', 'cached')),
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK(has_attachments IN (0, 1)),
  classification TEXT NOT NULL CHECK(classification IN ('general', 'verification', 'newsletter', 'outgoing', 'agent')),
  observed_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_mail_messages_live_observed
ON mail_messages(observed_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE INDEX idx_mail_messages_rfc_id
ON mail_messages(lower(rfc_message_id))
WHERE rfc_message_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE mail_message_sources (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('temporary_session', 'imap', 'smtp', 'local_draft', 'agent')),
  source_ref_id TEXT NOT NULL,
  account_id TEXT REFERENCES mail_accounts(id) ON DELETE SET NULL,
  session_id TEXT,
  provider_instance_id TEXT,
  external_message_id TEXT,
  received_address TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_state IN ('active', 'expired', 'released', 'history_only', 'draft', 'ready')),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0, 1)),
  is_starred INTEGER NOT NULL DEFAULT 0 CHECK(is_starred IN (0, 1)),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0, 1)),
  is_important INTEGER NOT NULL DEFAULT 0 CHECK(is_important IN (0, 1)),
  local_folder TEXT NOT NULL DEFAULT 'inbox',
  labels_json TEXT NOT NULL DEFAULT '[]',
  draft_cc_json TEXT NOT NULL DEFAULT '[]',
  draft_bcc_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_mail_message_sources_dedupe
ON mail_message_sources(source_kind, source_ref_id, external_message_id)
WHERE external_message_id IS NOT NULL;

CREATE INDEX idx_mail_message_sources_message
ON mail_message_sources(message_id, first_seen_at ASC, id ASC);

CREATE INDEX idx_mail_message_sources_account
ON mail_message_sources(account_id, last_seen_at DESC, id DESC)
WHERE account_id IS NOT NULL;

CREATE INDEX idx_mail_message_sources_session
ON mail_message_sources(session_id, last_seen_at DESC, id DESC)
WHERE session_id IS NOT NULL;

CREATE INDEX idx_mail_message_sources_folder
ON mail_message_sources(local_folder, message_id);

CREATE TABLE mail_verification_codes (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  session_id TEXT,
  source_ref_id TEXT NOT NULL,
  account_scope TEXT NOT NULL CHECK(account_scope IN ('anonymous', 'normal', 'promoted', 'agent')),
  received_address TEXT NOT NULL,
  code TEXT NOT NULL,
  code_source TEXT NOT NULL CHECK(code_source IN ('subject', 'text', 'html')),
  candidates_json TEXT NOT NULL DEFAULT '[]',
  issuer_hint TEXT,
  target_service_hint TEXT,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  expires_at TEXT,
  extracted_at TEXT NOT NULL,
  UNIQUE(message_id, code)
);

CREATE INDEX idx_mail_verification_codes_recent
ON mail_verification_codes(extracted_at DESC, id DESC);

CREATE INDEX idx_mail_verification_codes_session
ON mail_verification_codes(session_id, extracted_at DESC, id DESC)
WHERE session_id IS NOT NULL;
`,
  },
  {
    version: 7,
    name: "mail-smtp-and-send-queue",
    sql: `
ALTER TABLE mail_accounts ADD COLUMN smtp_host TEXT CHECK(smtp_host IS NULL OR (length(trim(smtp_host)) >= 1 AND length(smtp_host) <= 253));
ALTER TABLE mail_accounts ADD COLUMN smtp_port INTEGER CHECK(smtp_port IS NULL OR (smtp_port >= 1 AND smtp_port <= 65535));
ALTER TABLE mail_accounts ADD COLUMN smtp_security TEXT CHECK(smtp_security IS NULL OR smtp_security IN ('tls', 'starttls'));
ALTER TABLE mail_accounts ADD COLUMN smtp_username TEXT CHECK(smtp_username IS NULL OR (length(trim(smtp_username)) >= 1 AND length(smtp_username) <= 320));

CREATE TRIGGER validate_mail_account_smtp_profile_insert
BEFORE INSERT ON mail_accounts
WHEN NOT (
  (NEW.smtp_host IS NULL AND NEW.smtp_port IS NULL AND NEW.smtp_security IS NULL AND NEW.smtp_username IS NULL)
  OR (
    NEW.kind != 'anonymous_virtual'
    AND NEW.smtp_host IS NOT NULL
    AND NEW.smtp_port IS NOT NULL
    AND NEW.smtp_security IS NOT NULL
    AND NEW.smtp_username IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_MAIL_ACCOUNT_SMTP_PROFILE');
END;

CREATE TRIGGER validate_mail_account_smtp_profile_update
BEFORE UPDATE OF kind, smtp_host, smtp_port, smtp_security, smtp_username ON mail_accounts
WHEN NOT (
  (NEW.smtp_host IS NULL AND NEW.smtp_port IS NULL AND NEW.smtp_security IS NULL AND NEW.smtp_username IS NULL)
  OR (
    NEW.kind != 'anonymous_virtual'
    AND NEW.smtp_host IS NOT NULL
    AND NEW.smtp_port IS NOT NULL
    AND NEW.smtp_security IS NOT NULL
    AND NEW.smtp_username IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_MAIL_ACCOUNT_SMTP_PROFILE');
END;

CREATE TABLE mail_send_queue (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  account_scope TEXT NOT NULL CHECK(account_scope IN ('normal', 'agent')),
  source_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  sender_address TEXT NOT NULL,
  smtp_host TEXT NOT NULL CHECK(length(trim(smtp_host)) >= 1 AND length(smtp_host) <= 253),
  smtp_port INTEGER NOT NULL CHECK(smtp_port >= 1 AND smtp_port <= 65535),
  smtp_security TEXT NOT NULL CHECK(smtp_security IN ('tls', 'starttls')),
  smtp_username TEXT NOT NULL CHECK(length(trim(smtp_username)) >= 1 AND length(smtp_username) <= 320),
  credential_ref_id TEXT NOT NULL REFERENCES mail_account_credential_refs(id) ON DELETE RESTRICT,
  target_address TEXT NOT NULL,
  cc_addresses_json TEXT NOT NULL DEFAULT '[]',
  bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT,
  payload_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'sending', 'sent', 'auth_failed', 'delivery_unknown', 'cancelled', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  scheduled_at TEXT,
  next_retry_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  provider_message_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE UNIQUE INDEX idx_mail_send_queue_idempotency
ON mail_send_queue(account_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_mail_send_queue_claim_due
ON mail_send_queue(status, next_retry_at, created_at, id);

CREATE INDEX idx_mail_send_queue_lease
ON mail_send_queue(status, lease_expires_at);

CREATE INDEX idx_mail_send_queue_recent
ON mail_send_queue(created_at DESC, id DESC);

CREATE INDEX idx_mail_send_queue_message
ON mail_send_queue(message_id, status);
`,
  },
  {
    version: 8,
    name: "mail-imap-folders-and-sync-state",
    sql: MAIL_IMAP_SYNC_MIGRATION_SQL,
  },
  {
    version: 9,
    name: "mail-promotion-newsletters-and-settings",
    sql: MAIL_M7A_EXTENSIONS_MIGRATION_SQL,
  },
  {
    version: 10,
    name: "mail-agent-services-threads-and-messages",
    sql: MAIL_M7B_AGENT_MIGRATION_SQL,
  },
  {
    version: 11,
    name: "mail-avatar-settings-cache-and-overrides",
    sql: MAIL_M7C_AVATARS_MIGRATION_SQL,
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
