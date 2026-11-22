CREATE TABLE normal_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  email_address TEXT NOT NULL,
  display_name TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  username TEXT NOT NULL,
  credential_cipher TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  test_token TEXT,
  test_lease_until INTEGER,
  tested_at INTEGER,
  test_error TEXT,
  inbox_uid_validity TEXT,
  inbox_messages INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX normal_accounts_private_address ON normal_accounts(user_id,email_address COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX normal_accounts_owner ON normal_accounts(user_id,id);
CREATE TABLE normal_account_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER,
  deleted INTEGER NOT NULL CHECK (deleted IN (0,1)),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(user_id,request_key)
);
