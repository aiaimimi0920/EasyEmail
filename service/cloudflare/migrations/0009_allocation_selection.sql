ALTER TABLE mailbox_creations ADD COLUMN provider_id TEXT;
ALTER TABLE mailbox_creations ADD COLUMN provider_revision INTEGER;
ALTER TABLE mailbox_creations ADD COLUMN provider_hash TEXT;

CREATE TABLE provider_allocation_state (
  provider_id TEXT PRIMARY KEY,
  config_revision INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  operation_sequence INTEGER NOT NULL DEFAULT 0 CHECK (operation_sequence >= 0),
  observation_version INTEGER NOT NULL DEFAULT 0 CHECK (observation_version >= 0),
  allocation_count INTEGER NOT NULL DEFAULT 0 CHECK (allocation_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  cooldown_until INTEGER,
  last_error TEXT,
  last_failure_at INTEGER,
  last_success_at INTEGER
);
