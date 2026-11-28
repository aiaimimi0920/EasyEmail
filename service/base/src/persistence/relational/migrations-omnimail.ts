export const MAIL_OMNIMAIL_WORKBENCH_MIGRATION_SQL = `
CREATE TABLE mail_ai_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  provider TEXT NOT NULL DEFAULT 'openai',
  endpoint_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  model_name TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  credential_ref_key TEXT,
  include_subject INTEGER NOT NULL DEFAULT 1 CHECK(include_subject IN (0, 1)),
  require_consent INTEGER NOT NULL DEFAULT 1 CHECK(require_consent IN (0, 1)),
  translation_enabled INTEGER NOT NULL DEFAULT 1 CHECK(translation_enabled IN (0, 1)),
  translation_provider TEXT NOT NULL DEFAULT 'byok' CHECK(translation_provider IN ('byok', 'free')),
  translation_target_lang TEXT NOT NULL DEFAULT 'zh-CN',
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE mail_workbuddy_accounts (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL,
  email_address TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  base_url TEXT NOT NULL,
  mailbox_status TEXT NOT NULL DEFAULT 'running',
  credential_json TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 0,
  daily_remaining INTEGER NOT NULL DEFAULT 0,
  daily_reset INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mail_inbox_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  stop_processing INTEGER NOT NULL DEFAULT 1 CHECK(stop_processing IN (0, 1)),
  conditions_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_mail_inbox_rules_priority
ON mail_inbox_rules(priority ASC, created_at ASC, id ASC);

CREATE TABLE mail_sender_blocklist (
  pattern TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE mail_contact_aliases (
  alias_email TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_mail_contact_aliases_contact
ON mail_contact_aliases(contact_id);

CREATE TABLE mail_calendar_events (
  uid TEXT PRIMARY KEY,
  source_ref TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  organizer_email TEXT NOT NULL DEFAULT '',
  start_at_ms INTEGER NOT NULL,
  end_at_ms INTEGER NOT NULL,
  rsvp_status TEXT NOT NULL CHECK(rsvp_status IN ('needs-action', 'accepted', 'tentative', 'declined')),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_mail_calendar_events_window
ON mail_calendar_events(start_at_ms, end_at_ms);
`;
