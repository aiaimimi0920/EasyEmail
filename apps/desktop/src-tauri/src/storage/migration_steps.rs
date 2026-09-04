use rusqlite::{Connection, Result};

const MIGRATION_0001: &str = include_str!("../../migrations/0001_foundation.sql");
const MIGRATION_0002: &str = r#"
CREATE TABLE IF NOT EXISTS sender_avatar_cache (
  cache_key TEXT PRIMARY KEY,
  sender_domain TEXT NOT NULL,
  normalized_sender TEXT,
  source_kind TEXT NOT NULL,
  image_mime TEXT,
  image_bytes BLOB,
  remote_url TEXT,
  fallback_text TEXT NOT NULL,
  status TEXT NOT NULL,
  auth_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sender_avatar_cache_expires
ON sender_avatar_cache(expires_at);

CREATE TABLE IF NOT EXISTS contact_avatar_overrides (
  sender_key TEXT PRIMARY KEY,
  normalized_sender TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  image_mime TEXT NOT NULL,
  image_bytes BLOB NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_avatar_overrides_domain
ON contact_avatar_overrides(sender_domain);
"#;

const MIGRATION_0003: &str = r#"
ALTER TABLE send_queue
ADD COLUMN cc_addresses_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE send_queue
ADD COLUMN bcc_addresses_json TEXT NOT NULL DEFAULT '[]';
"#;

const MIGRATION_0004: &str = r#"
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email_address TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_display_name
ON contacts(display_name COLLATE NOCASE, email_address COLLATE NOCASE);
"#;

const MIGRATION_0005: &str = r#"
CREATE TABLE IF NOT EXISTS newsletter_subscription_overrides (
  account_id TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, subscription_key)
);

CREATE INDEX IF NOT EXISTS idx_newsletter_subscription_overrides_hidden
ON newsletter_subscription_overrides(account_id, hidden);
"#;

const MIGRATION_0006: &str = r##"
CREATE TABLE IF NOT EXISTS mail_taxonomy_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('folder', 'label')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_mail_taxonomy_items_kind_sort
ON mail_taxonomy_items(kind, sort_order, name COLLATE NOCASE);
"##;

const MIGRATION_0007: &str = r##"
DELETE FROM mail_taxonomy_items
WHERE kind = 'label'
  AND normalized_name = 'openai'
  AND system = 1;
"##;

const MIGRATION_0008: &str = r##"
ALTER TABLE mail_taxonomy_items
ADD COLUMN parent_id TEXT REFERENCES mail_taxonomy_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mail_taxonomy_items_kind_parent_sort
ON mail_taxonomy_items(kind, parent_id, sort_order, name COLLATE NOCASE);
"##;

const MIGRATION_0009: &str = r##"
CREATE INDEX IF NOT EXISTS idx_messages_thread_key
ON messages(thread_key);
"##;

/// Indexes for the join and filter columns used by every message list query.
///
/// `message_sources.message_id` is the join column in all list, detail, and
/// body-fetch queries and was previously unindexed, so each of those queries
/// scanned `message_sources` in full. The declared foreign keys do not create
/// indexes in SQLite, so the delete paths scanned it too.
///
/// The `lower(rfc_message_id)` expression index matches
/// `existing_thread_key_for_rfc_message_id`, which wraps the column in
/// `lower()` and therefore could not use `idx_messages_rfc_message_id`.
const MIGRATION_0010: &str = r##"
CREATE INDEX IF NOT EXISTS idx_message_sources_message_id
ON message_sources(message_id);

CREATE INDEX IF NOT EXISTS idx_message_sources_account_source
ON message_sources(account_id, source_id)
WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_sources_temp_mailbox
ON message_sources(temp_mailbox_id)
WHERE temp_mailbox_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_sources_folder
ON message_sources(folder_id)
WHERE folder_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_send_queue_message_id
ON send_queue(message_id);

CREATE INDEX IF NOT EXISTS idx_messages_active_date_received
ON messages(deleted_at, date_received DESC);

CREATE INDEX IF NOT EXISTS idx_messages_rfc_message_id_lower
ON messages(lower(rfc_message_id))
WHERE rfc_message_id IS NOT NULL;
"##;

/// One schema step. `apply` runs only when `version` is absent from
/// `schema_migrations`.
pub(super) struct Migration {
    pub(super) version: i64,
    pub(super) name: &'static str,
    pub(super) apply: fn(&Connection) -> Result<()>,
}

/// Applied in order. Adding a step means adding one row here, not another
/// copy of the check/apply/record block.
pub(super) const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "foundation",
        apply: |connection| connection.execute_batch(MIGRATION_0001),
    },
    Migration {
        version: 2,
        name: "sender-avatar-cache",
        apply: |connection| connection.execute_batch(MIGRATION_0002),
    },
    Migration {
        version: 3,
        name: "send-queue-recipient-lists",
        apply: |connection| connection.execute_batch(MIGRATION_0003),
    },
    Migration {
        version: 4,
        name: "explicit-contacts",
        apply: |connection| connection.execute_batch(MIGRATION_0004),
    },
    Migration {
        version: 5,
        name: "newsletter-subscription-overrides",
        apply: |connection| connection.execute_batch(MIGRATION_0005),
    },
    Migration {
        version: 6,
        name: "mail-taxonomy-items",
        apply: |connection| connection.execute_batch(MIGRATION_0006),
    },
    Migration {
        version: 7,
        name: "remove-builtin-openai-label",
        apply: |connection| connection.execute_batch(MIGRATION_0007),
    },
    Migration {
        version: 8,
        name: "mail-taxonomy-parent",
        apply: apply_mail_taxonomy_parent,
    },
    Migration {
        version: 9,
        name: "message-thread-key-index",
        apply: |connection| connection.execute_batch(MIGRATION_0009),
    },
    Migration {
        version: 10,
        name: "message-lookup-indexes",
        apply: |connection| connection.execute_batch(MIGRATION_0010),
    },
];

/// Databases created before this migration existed may already carry
/// `parent_id`, in which case the table rebuild must be skipped and only the
/// index added.
fn apply_mail_taxonomy_parent(connection: &Connection) -> Result<()> {
    let has_parent_id: bool = connection.query_row(
        "SELECT EXISTS(
            SELECT 1
            FROM pragma_table_info('mail_taxonomy_items')
            WHERE name = 'parent_id'
        )",
        [],
        |row| row.get(0),
    )?;

    if !has_parent_id {
        return connection.execute_batch(MIGRATION_0008);
    }

    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_mail_taxonomy_items_kind_parent_sort
         ON mail_taxonomy_items(kind, parent_id, sort_order, name COLLATE NOCASE)",
        [],
    )?;
    Ok(())
}
