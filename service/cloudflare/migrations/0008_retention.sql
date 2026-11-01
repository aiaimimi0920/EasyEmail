ALTER TABLE mailboxes ADD COLUMN expires_at INTEGER CHECK (expires_at IS NULL OR expires_at >= 0);
ALTER TABLE mailboxes ADD COLUMN expired_at INTEGER CHECK (expired_at IS NULL OR expired_at >= 0);
ALTER TABLE mailbox_creations ADD COLUMN expires_at INTEGER;
ALTER TABLE mailbox_creations ADD COLUMN policy_revision INTEGER;
ALTER TABLE outgoing_messages ADD COLUMN content_purged_at INTEGER;
CREATE INDEX mailboxes_expiry ON mailboxes(expires_at,id) WHERE expired_at IS NULL;
CREATE INDEX messages_retention_age ON messages(observed_at,id) WHERE purged_at IS NULL;
CREATE INDEX messages_retention_trash ON messages(trashed_at,id) WHERE purged_at IS NULL;
CREATE INDEX outgoing_retention_age ON outgoing_messages(updated_at,id) WHERE content_purged_at IS NULL AND state <> 'pending';

CREATE TABLE retention_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  mailbox_days INTEGER NOT NULL CHECK (mailbox_days BETWEEN 0 AND 3650),
  cache_days INTEGER NOT NULL CHECK (cache_days BETWEEN 0 AND 3650),
  trash_days INTEGER NOT NULL CHECK (trash_days BETWEEN 0 AND 3650),
  outgoing_days INTEGER NOT NULL CHECK (outgoing_days BETWEEN 0 AND 3650),
  audit_days INTEGER NOT NULL CHECK (audit_days BETWEEN 0 AND 3650),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  change_token TEXT,
  updated_at INTEGER,
  actor_id TEXT REFERENCES users(id)
);
INSERT INTO retention_policy VALUES (1,0,0,0,0,0,0,0,NULL,NULL,NULL);

CREATE TABLE retention_policy_changes (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE retention_runs (
  id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  policy_hash TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','scheduled')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  expired_mailboxes INTEGER NOT NULL DEFAULT 0,
  purged_messages INTEGER NOT NULL DEFAULT 0,
  redacted_outgoing INTEGER NOT NULL DEFAULT 0,
  pruned_audit INTEGER NOT NULL DEFAULT 0
);
