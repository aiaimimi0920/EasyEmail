CREATE TABLE normal_server_folder_catalogs (
  account_id TEXT PRIMARY KEY REFERENCES normal_accounts(id),
  source_hash TEXT,
  snapshot_id TEXT,
  snapshot_revision INTEGER,
  folders TEXT CHECK (folders IS NULL OR (json_valid(folders) AND json_type(folders)='array')),
  observed_at INTEGER,
  claim_token TEXT,
  claim_revision INTEGER,
  claim_lease_until INTEGER,
  CHECK ((snapshot_id IS NULL AND source_hash IS NULL AND snapshot_revision IS NULL AND folders IS NULL AND observed_at IS NULL)
    OR (snapshot_id IS NOT NULL AND source_hash IS NOT NULL AND snapshot_revision IS NOT NULL AND folders IS NOT NULL AND observed_at IS NOT NULL)),
  CHECK ((claim_token IS NULL AND claim_revision IS NULL AND claim_lease_until IS NULL)
    OR (claim_token IS NOT NULL AND claim_revision IS NOT NULL AND claim_lease_until IS NOT NULL))
);
