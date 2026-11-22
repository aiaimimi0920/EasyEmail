-- Expand only: independent SMTP credentials and permanent request guards.
CREATE TABLE normal_smtp_configs (
  account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  endpoint_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  username TEXT NOT NULL,
  credential_cipher TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id,account_id) REFERENCES normal_accounts(user_id,id)
);
CREATE TABLE normal_smtp_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,request_key),
  FOREIGN KEY(user_id,account_id) REFERENCES normal_accounts(user_id,id)
);
CREATE TABLE normal_outgoing_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  smtp_revision INTEGER NOT NULL,
  endpoint_hash TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  recipients_json TEXT,
  recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 1 AND 50),
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','rejected','unknown')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  content_purged_at INTEGER,
  UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,account_id) REFERENCES normal_accounts(user_id,id)
);
CREATE INDEX normal_outgoing_timeline ON normal_outgoing_messages(user_id,account_id,created_at DESC,id DESC);
CREATE INDEX normal_outgoing_user_quota ON normal_outgoing_messages(user_id,created_at);
CREATE INDEX normal_outgoing_global_quota ON normal_outgoing_messages(created_at);
CREATE INDEX normal_outgoing_pending ON normal_outgoing_messages(state,created_at);
CREATE VIEW send_recipient_charges AS
  SELECT user_id,recipient_count,created_at FROM outgoing_messages
  UNION ALL SELECT user_id,recipient_count,created_at FROM normal_outgoing_messages;
