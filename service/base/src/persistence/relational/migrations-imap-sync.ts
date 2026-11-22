export const MAIL_IMAP_SYNC_MIGRATION_SQL = `
CREATE TABLE mail_imap_folders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  source_ref_id TEXT NOT NULL,
  provider_folder_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  path TEXT NOT NULL,
  delimiter TEXT NOT NULL DEFAULT '/',
  folder_kind TEXT NOT NULL CHECK(folder_kind IN ('inbox', 'archive', 'spam', 'trash', 'sent', 'drafts', 'mail')),
  special_use TEXT,
  uid_validity TEXT,
  last_seen_uid TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, provider_folder_id)
);

CREATE INDEX idx_mail_imap_folders_account_kind
ON mail_imap_folders(account_id, folder_kind, display_name COLLATE NOCASE, id);

CREATE TABLE mail_account_sync_checkpoints (
  account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  sync_state TEXT NOT NULL CHECK(sync_state IN ('never_synced', 'syncing', 'synced', 'stale', 'auth_failed', 'error')),
  last_attempt_at TEXT,
  last_synced_at TEXT,
  last_fetched_count INTEGER NOT NULL DEFAULT 0 CHECK(last_fetched_count >= 0),
  last_inserted_count INTEGER NOT NULL DEFAULT 0 CHECK(last_inserted_count >= 0),
  last_error_code TEXT,
  last_error_message TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE mail_message_sources ADD COLUMN imap_folder_id TEXT REFERENCES mail_imap_folders(id) ON DELETE SET NULL;
ALTER TABLE mail_message_sources ADD COLUMN imap_uid TEXT;
ALTER TABLE mail_message_sources ADD COLUMN imap_uid_validity TEXT;

CREATE INDEX idx_mail_message_sources_imap_uid
ON mail_message_sources(account_id, imap_folder_id, imap_uid)
WHERE imap_folder_id IS NOT NULL AND imap_uid IS NOT NULL;
`;
