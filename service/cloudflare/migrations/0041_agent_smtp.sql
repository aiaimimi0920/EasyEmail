-- Expand only: Agent SMTP is independent of normal SMTP and Agent IMAP credentials.
CREATE UNIQUE INDEX agent_accounts_smtp_owner ON agent_accounts(user_id,id);
CREATE TABLE agent_smtp_configs (
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
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE TABLE agent_smtp_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  revision INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(user_id,request_key),
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
-- The schema owns credential retirement even while an older account writer is active.
CREATE TRIGGER agent_smtp_account_retirement AFTER UPDATE OF credential_cipher,deleted_at ON agent_accounts
WHEN NEW.deleted_at IS NOT NULL OR NEW.credential_cipher IS NULL
BEGIN
  UPDATE agent_smtp_configs SET credential_cipher=NULL,username='',enabled=0,
    revision=CASE WHEN revision<9007199254740991 THEN revision+1 ELSE revision END,updated_at=NEW.updated_at
  WHERE user_id=NEW.user_id AND account_id=NEW.id AND (credential_cipher IS NOT NULL OR username<>'' OR enabled<>0);
END;
