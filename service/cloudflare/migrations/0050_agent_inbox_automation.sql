-- Explicit owner authorization; never inferred from an enabled IMAP account or an old API Key.
CREATE TABLE agent_inbox_automation (
  account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  account_revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  interval_minutes INTEGER NOT NULL CHECK(interval_minutes IN (5,15,60)),
  next_due_at INTEGER,
  run_token TEXT,
  run_request_id TEXT,
  lease_until INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  last_state TEXT NOT NULL DEFAULT 'idle' CHECK(last_state IN ('idle','running','committed','failed','interrupted')),
  last_error_code TEXT,
  last_request_key TEXT,
  last_started_at INTEGER,
  last_finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK((run_token IS NULL AND run_request_id IS NULL AND lease_until IS NULL)
    OR (run_token IS NOT NULL AND run_request_id IS NOT NULL AND lease_until IS NOT NULL)),
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE INDEX agent_inbox_automation_due ON agent_inbox_automation(next_due_at,account_id) WHERE enabled=1 AND next_due_at IS NOT NULL;
CREATE INDEX agent_inbox_automation_leases ON agent_inbox_automation(lease_until,account_id) WHERE run_token IS NOT NULL;
CREATE TABLE agent_inbox_automation_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  expected_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  interval_minutes INTEGER NOT NULL CHECK(interval_minutes IN (5,15,60)),
  completed_at INTEGER,
  UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
-- Any account edit invalidates the old binding, without rewriting the saved user configuration or its receipts.
CREATE TRIGGER agent_inbox_automation_account_changed AFTER UPDATE ON agent_accounts
WHEN OLD.revision IS NOT NEW.revision OR OLD.endpoint_hash IS NOT NEW.endpoint_hash OR OLD.username IS NOT NEW.username
  OR OLD.email_address IS NOT NEW.email_address OR OLD.credential_cipher IS NOT NEW.credential_cipher
  OR OLD.enabled IS NOT NEW.enabled OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  UPDATE agent_inbox_automation SET next_due_at=NULL,run_token=NULL,run_request_id=NULL,lease_until=NULL,
    last_state=CASE WHEN last_state='running' THEN 'interrupted' ELSE last_state END,
    last_error_code='agent_inbox_changed',updated_at=unixepoch() WHERE account_id=NEW.id;
END;
