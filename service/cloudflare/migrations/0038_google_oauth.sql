ALTER TABLE normal_accounts ADD COLUMN authentication TEXT NOT NULL DEFAULT 'password' CHECK(authentication IN ('password','google-oauth2'));
ALTER TABLE normal_accounts ADD COLUMN oauth_grant_id TEXT;
ALTER TABLE normal_accounts ADD COLUMN oauth_flow_id TEXT;
CREATE TABLE google_oauth_attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  session_hash TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, account_revision INTEGER NOT NULL,
  config_hash TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE, secret_cipher TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','exchanging','completed','failed')),
  claim TEXT, exchange_until INTEGER, result_revision INTEGER, error_code TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(user_id,request_key)
);
CREATE INDEX google_oauth_attempt_expiry ON google_oauth_attempts(state,expires_at);
CREATE TABLE google_oauth_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  config_hash TEXT NOT NULL, endpoint_hash TEXT NOT NULL, username TEXT NOT NULL, email_address TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','reauthorize','disconnected')), version INTEGER NOT NULL,
  secret_cipher TEXT, expires_at INTEGER NOT NULL, refresh_claim TEXT, refresh_until INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX google_oauth_grant_account ON google_oauth_grants(user_id,account_id);
CREATE TABLE google_oauth_disconnects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(user_id,request_key)
);
