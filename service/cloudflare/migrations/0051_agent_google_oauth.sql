-- Expand only. Old password rows, receipts and table definitions remain intact.
CREATE TABLE agent_google_oauth_bindings (
  account_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, oauth_grant_id TEXT, oauth_flow_id TEXT,
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE VIEW agent_google_oauth_accounts AS SELECT a.*,
  CASE WHEN b.account_id IS NULL THEN 'password' ELSE 'google-oauth2' END AS authentication,
  b.oauth_grant_id,b.oauth_flow_id FROM agent_accounts a
  LEFT JOIN agent_google_oauth_bindings b ON b.account_id=a.id AND b.user_id=a.user_id;
CREATE TABLE agent_google_oauth_attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  session_hash TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, account_revision INTEGER NOT NULL,
  config_hash TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE, secret_cipher TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','exchanging','completed','failed')),
  claim TEXT, exchange_until INTEGER, result_revision INTEGER, error_code TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE INDEX agent_google_oauth_attempt_expiry ON agent_google_oauth_attempts(state,expires_at);
CREATE TABLE agent_google_oauth_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  config_hash TEXT NOT NULL, endpoint_hash TEXT NOT NULL, username TEXT NOT NULL, email_address TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','reauthorize','disconnected')), version INTEGER NOT NULL,
  secret_cipher TEXT, expires_at INTEGER NOT NULL, refresh_claim TEXT, refresh_until INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE INDEX agent_google_oauth_grant_account ON agent_google_oauth_grants(user_id,account_id);
CREATE TABLE agent_google_oauth_disconnects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(user_id,request_key), FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
-- Even old password writers invalidate a pending flow on any logical account edit.
CREATE TRIGGER agent_google_oauth_flow_changed AFTER UPDATE ON agent_accounts
WHEN OLD.revision IS NOT NEW.revision OR OLD.endpoint_hash IS NOT NEW.endpoint_hash OR OLD.username IS NOT NEW.username
  OR OLD.email_address IS NOT NEW.email_address OR OLD.enabled IS NOT NEW.enabled
  OR OLD.credential_cipher IS NOT NEW.credential_cipher OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  UPDATE agent_google_oauth_bindings SET oauth_flow_id=NULL WHERE user_id=NEW.user_id AND account_id=NEW.id;
END;
-- Only the formerly bound grant is retired; a newly inserted installation is not that grant.
CREATE TRIGGER agent_google_oauth_credential_retirement AFTER UPDATE ON agent_accounts
WHEN OLD.endpoint_hash IS NOT NEW.endpoint_hash OR OLD.username IS NOT NEW.username OR OLD.email_address IS NOT NEW.email_address
  OR OLD.credential_cipher IS NOT NEW.credential_cipher OR NEW.credential_cipher IS NULL OR NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE agent_google_oauth_grants SET state='disconnected',secret_cipher=NULL,version=version+1,
    refresh_claim=NULL,refresh_until=NULL,updated_at=unixepoch()
    WHERE id=(SELECT oauth_grant_id FROM agent_google_oauth_bindings WHERE user_id=NEW.user_id AND account_id=NEW.id);
  UPDATE agent_google_oauth_bindings SET oauth_grant_id=NULL WHERE user_id=NEW.user_id AND account_id=NEW.id;
END;
