CREATE TABLE normal_server_folder_sync_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  server_folder_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT,
  UNIQUE(account_id,request_key)
);
CREATE INDEX normal_server_folder_requests_page ON normal_server_folder_sync_requests(account_id,server_folder_id,created_at DESC,id);
CREATE TABLE normal_server_folder_state (
  account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  server_folder_id TEXT NOT NULL,
  wire_name TEXT NOT NULL,
  source_hash TEXT,
  epoch_id TEXT,
  uid_validity TEXT,
  after_uid INTEGER NOT NULL DEFAULT 0 CHECK(after_uid BETWEEN 0 AND 4294967295),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 9007199254740990),
  cache_generation INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claim_revision INTEGER,
  claim_lease_until INTEGER,
  request_id TEXT REFERENCES normal_server_folder_sync_requests(id),
  updated_at INTEGER,
  PRIMARY KEY(account_id,server_folder_id),
  CHECK((source_hash IS NULL AND epoch_id IS NULL AND uid_validity IS NULL AND after_uid=0)
    OR (source_hash IS NOT NULL AND epoch_id IS NOT NULL AND uid_validity IS NOT NULL)),
  CHECK((claim_token IS NULL AND claim_revision IS NULL AND claim_lease_until IS NULL)
    OR (claim_token IS NOT NULL AND claim_revision IS NOT NULL AND claim_lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX normal_server_folder_epoch ON normal_server_folder_state(epoch_id) WHERE epoch_id IS NOT NULL;
ALTER TABLE normal_inbox_batches ADD COLUMN server_folder_id TEXT;
ALTER TABLE normal_inbox_batches ADD COLUMN server_request_id TEXT REFERENCES normal_server_folder_sync_requests(id);
CREATE UNIQUE INDEX normal_server_folder_batch_request ON normal_inbox_batches(server_request_id) WHERE server_request_id IS NOT NULL;
ALTER TABLE normal_inbox_messages ADD COLUMN server_folder_id TEXT;
CREATE INDEX normal_server_folder_messages ON normal_inbox_messages(account_id,server_folder_id,epoch_id,uid);
CREATE VIEW normal_receive_leases AS
  SELECT account_id,claim_token,claim_lease_until FROM normal_inbox_state
  UNION ALL SELECT account_id,claim_token,claim_lease_until FROM normal_server_folder_state;
