-- Expand-only schema for PrivacyGuard BYOK AI, fidelity translation, WorkBuddy Agent mail,
-- inbox rules, contact aliases, and calendar invite RSVPs.
CREATE TABLE user_ai_configs (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  provider TEXT NOT NULL DEFAULT 'openai',
  endpoint_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  model_name TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  credential_cipher TEXT,
  include_subject INTEGER NOT NULL DEFAULT 1 CHECK(include_subject IN (0, 1)),
  require_consent INTEGER NOT NULL DEFAULT 1 CHECK(require_consent IN (0, 1)),
  translation_enabled INTEGER NOT NULL DEFAULT 1 CHECK(translation_enabled IN (0, 1)),
  translation_provider TEXT NOT NULL DEFAULT 'byok' CHECK(translation_provider IN ('byok', 'free')),
  translation_target_lang TEXT NOT NULL DEFAULT 'zh-CN',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  updated_at INTEGER NOT NULL
);

CREATE TABLE workbuddy_auth_sessions (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  base_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  auth_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX workbuddy_auth_sessions_user ON workbuddy_auth_sessions(user_id, created_at DESC);

CREATE TABLE workbuddy_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  alias_id TEXT NOT NULL,
  email_address TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL,
  base_url TEXT NOT NULL,
  mailbox_status TEXT NOT NULL DEFAULT 'running',
  token_cipher TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 0,
  daily_remaining INTEGER NOT NULL DEFAULT 0,
  daily_reset INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX workbuddy_accounts_live_email
  ON workbuddy_accounts(user_id, email_address) WHERE deleted_at IS NULL;
CREATE INDEX workbuddy_accounts_user ON workbuddy_accounts(user_id, created_at DESC);

CREATE TABLE inbox_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  stop_processing INTEGER NOT NULL DEFAULT 1 CHECK(stop_processing IN (0, 1)),
  conditions_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX inbox_rules_user_priority ON inbox_rules(user_id, priority ASC, created_at ASC);

CREATE TABLE sender_blocklist (
  user_id TEXT NOT NULL REFERENCES users(id),
  pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pattern)
);

CREATE TABLE contact_aliases (
  user_id TEXT NOT NULL REFERENCES users(id),
  alias_email TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, alias_email)
);
CREATE INDEX contact_aliases_contact ON contact_aliases(user_id, contact_id);

CREATE TABLE calendar_events (
  user_id TEXT NOT NULL REFERENCES users(id),
  uid TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  organizer_email TEXT NOT NULL DEFAULT '',
  start_at_ms INTEGER NOT NULL,
  end_at_ms INTEGER NOT NULL,
  rsvp_status TEXT NOT NULL CHECK(rsvp_status IN ('needs-action', 'accepted', 'tentative', 'declined')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, uid)
);
CREATE INDEX calendar_events_window ON calendar_events(user_id, start_at_ms, end_at_ms);
