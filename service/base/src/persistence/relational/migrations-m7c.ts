export const MAIL_M7C_AVATARS_MIGRATION_SQL = `
CREATE TABLE mail_avatar_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  remote_enabled INTEGER NOT NULL DEFAULT 1 CHECK (remote_enabled IN (0, 1)),
  bimi_enabled INTEGER NOT NULL DEFAULT 1 CHECK (bimi_enabled IN (0, 1)),
  favicon_enabled INTEGER NOT NULL DEFAULT 1 CHECK (favicon_enabled IN (0, 1)),
  auth_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auth_enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE mail_sender_avatar_cache (
  cache_key TEXT PRIMARY KEY,
  sender_domain TEXT NOT NULL,
  normalized_sender TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  image_mime TEXT,
  image_bytes BLOB,
  remote_url TEXT,
  fallback_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  auth_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_mail_sender_avatar_cache_expires
ON mail_sender_avatar_cache(expires_at);

CREATE INDEX idx_mail_sender_avatar_cache_domain
ON mail_sender_avatar_cache(sender_domain);

CREATE TABLE mail_contact_avatar_overrides (
  sender_key TEXT PRIMARY KEY,
  contact_id TEXT,
  normalized_sender TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  image_mime TEXT NOT NULL,
  image_bytes BLOB NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_mail_contact_avatar_overrides_contact
ON mail_contact_avatar_overrides(contact_id)
WHERE contact_id IS NOT NULL;
`;
