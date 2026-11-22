CREATE TABLE normal_message_state (
  message_id TEXT PRIMARY KEY REFERENCES normal_inbox_messages(id),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
  starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  trashed_at INTEGER
);
CREATE TABLE normal_organization_operations (
  account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  epoch_id TEXT NOT NULL,
  required_scopes TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(account_id,request_key)
);
