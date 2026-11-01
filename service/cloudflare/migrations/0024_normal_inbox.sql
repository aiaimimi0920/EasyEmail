CREATE TABLE normal_inbox_state (
  account_id TEXT PRIMARY KEY REFERENCES normal_accounts(id),
  source_hash TEXT,
  epoch_id TEXT,
  uid_validity TEXT,
  after_uid INTEGER NOT NULL DEFAULT 0 CHECK (after_uid BETWEEN 0 AND 4294967295),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740990),
  claim_token TEXT,
  claim_revision INTEGER,
  claim_lease_until INTEGER,
  updated_at INTEGER,
  CHECK ((source_hash IS NULL AND epoch_id IS NULL AND uid_validity IS NULL AND after_uid=0)
    OR (source_hash IS NOT NULL AND epoch_id IS NOT NULL AND uid_validity IS NOT NULL)),
  CHECK ((claim_token IS NULL AND claim_revision IS NULL AND claim_lease_until IS NULL)
    OR (claim_token IS NOT NULL AND claim_revision IS NOT NULL AND claim_lease_until IS NOT NULL))
);
CREATE TABLE normal_inbox_batches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  account_revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  epoch_id TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  after_uid INTEGER NOT NULL CHECK (after_uid BETWEEN 0 AND 4294967295),
  reset INTEGER NOT NULL CHECK (reset IN (0,1)),
  complete INTEGER NOT NULL CHECK (complete IN (0,1)),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 3),
  storage_bytes INTEGER NOT NULL CHECK (storage_bytes BETWEEN 0 AND 12582912),
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  status TEXT NOT NULL CHECK (status IN ('staged','committed')),
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  CHECK ((status='staged' AND committed_at IS NULL) OR (status='committed' AND committed_at IS NOT NULL))
);
CREATE INDEX normal_inbox_batches_owner ON normal_inbox_batches(account_id,status,id);
CREATE TABLE normal_inbox_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  batch_id TEXT NOT NULL REFERENCES normal_inbox_batches(id),
  epoch_id TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  uid INTEGER NOT NULL CHECK (uid BETWEEN 1 AND 4294967295),
  raw_key TEXT NOT NULL UNIQUE,
  content_key TEXT NOT NULL UNIQUE,
  raw_sha256 TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes BETWEEN 1 AND 2097152),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 2097152),
  received_at INTEGER NOT NULL,
  flags TEXT NOT NULL CHECK (json_valid(flags)),
  observed_at INTEGER NOT NULL,
  UNIQUE(account_id,epoch_id,uid)
);
CREATE INDEX normal_inbox_messages_epoch ON normal_inbox_messages(account_id,epoch_id,uid);
