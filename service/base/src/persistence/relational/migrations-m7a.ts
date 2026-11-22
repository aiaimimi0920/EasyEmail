export const MAIL_M7A_EXTENSIONS_MIGRATION_SQL = `
ALTER TABLE mail_messages
ADD COLUMN newsletter_list_id TEXT;

ALTER TABLE mail_messages
ADD COLUMN newsletter_unsubscribe_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE mail_newsletter_subscription_overrides (
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  subscription_key TEXT NOT NULL CHECK(length(trim(subscription_key)) >= 1 AND length(subscription_key) <= 1024),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, subscription_key)
);

CREATE INDEX idx_mail_newsletter_overrides_account_hidden
ON mail_newsletter_subscription_overrides(account_id, hidden);

CREATE TABLE mail_client_settings (
  setting_key TEXT PRIMARY KEY CHECK(length(trim(setting_key)) >= 1 AND length(setting_key) <= 128),
  setting_value TEXT,
  updated_at TEXT NOT NULL
);
`;
