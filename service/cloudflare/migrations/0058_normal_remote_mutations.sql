-- Permanent operation facts also own the physical IMAP target lock. Never expire unknown or removed targets.
CREATE TABLE normal_remote_mutation_operations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  message_id TEXT NOT NULL REFERENCES normal_inbox_messages(id),
  account_revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  cache_generation INTEGER NOT NULL,
  uid_validity TEXT NOT NULL,
  uid INTEGER NOT NULL CHECK (uid BETWEEN 1 AND 4294967295),
  server_folder_id TEXT,
  server_wire_name TEXT,
  catalog_source TEXT,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('move','delete')),
  destination_folder_id TEXT,
  destination_wire_name TEXT,
  destination_catalog_source TEXT,
  destination_source_hash TEXT,
  destination_epoch_id TEXT,
  destination_uid_validity TEXT,
  destination_cache_generation INTEGER,
  destination_uid INTEGER CHECK (destination_uid BETWEEN 1 AND 4294967295),
  state TEXT NOT NULL CHECK (state IN ('pending','confirmed','failed','unknown')),
  phase TEXT CHECK (phase IN ('move','copy','mark-deleted','expunge')),
  method TEXT CHECK (method IN ('move','copy-expunge','delete')),
  source_removed INTEGER NOT NULL DEFAULT 0 CHECK (source_removed IN (0,1)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  phase_at INTEGER,
  finished_at INTEGER,
  UNIQUE(user_id,request_key),
  CHECK ((server_folder_id IS NULL AND server_wire_name IS NULL AND catalog_source IS NULL)
    OR (server_folder_id IS NOT NULL AND server_wire_name IS NOT NULL AND catalog_source IS NOT NULL
      AND length(server_folder_id)=64 AND server_folder_id NOT GLOB '*[^0-9a-f]*'
      AND length(catalog_source)=64 AND catalog_source NOT GLOB '*[^0-9a-f]*'
      AND length(server_wire_name) BETWEEN 1 AND 1024 AND upper(server_wire_name)<>'INBOX')),
  CHECK ((action='delete' AND destination_folder_id IS NULL AND destination_wire_name IS NULL
    AND destination_catalog_source IS NULL AND destination_source_hash IS NULL AND destination_epoch_id IS NULL
    AND destination_uid_validity IS NULL AND destination_cache_generation IS NULL AND destination_uid IS NULL)
    OR (action='move' AND destination_folder_id IS NOT NULL AND destination_wire_name IS NOT NULL
      AND destination_catalog_source IS NOT NULL AND destination_source_hash IS NOT NULL AND destination_epoch_id IS NOT NULL
      AND destination_uid_validity IS NOT NULL AND destination_cache_generation IS NOT NULL
      AND destination_wire_name<>COALESCE(server_wire_name,'INBOX'))),
  CHECK ((phase IS NULL)=(dispatched_at IS NULL) AND (phase IS NULL)=(phase_at IS NULL)),
  CHECK (state<>'failed' OR dispatched_at IS NULL),
  CHECK (state<>'confirmed' OR (dispatched_at IS NOT NULL AND finished_at IS NOT NULL AND source_removed=1 AND method IS NOT NULL
    AND ((action='delete' AND method='delete' AND phase='expunge')
      OR (action='move' AND destination_uid IS NOT NULL
        AND ((method='move' AND phase='move') OR (method='copy-expunge' AND phase='expunge'))))))
);
CREATE INDEX normal_remote_mutation_history ON normal_remote_mutation_operations(message_id,sequence DESC);
CREATE UNIQUE INDEX normal_remote_mutation_target ON normal_remote_mutation_operations
  (account_id,COALESCE(server_wire_name,'INBOX'),uid_validity,uid) WHERE state<>'failed';
CREATE INDEX normal_remote_flags_physical_target ON normal_remote_flag_operations
  (account_id,COALESCE(server_wire_name,'INBOX'),uid_validity,uid,sequence DESC);

-- Symmetric database fences also protect callers still running the pre-0058 flag writer.
CREATE TRIGGER normal_remote_mutation_excludes_flags BEFORE INSERT ON normal_remote_mutation_operations
WHEN NEW.state<>'failed'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM normal_remote_flag_operations f WHERE f.account_id=NEW.account_id
      AND COALESCE(f.server_wire_name,'INBOX')=COALESCE(NEW.server_wire_name,'INBOX')
      AND f.uid_validity=NEW.uid_validity AND f.uid=NEW.uid AND f.state IN ('pending','unknown')
  ) THEN RAISE(ABORT,'remote_write_target_busy') END;
END;
CREATE TRIGGER normal_remote_flags_exclude_mutation_insert BEFORE INSERT ON normal_remote_flag_operations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM normal_remote_mutation_operations o WHERE o.account_id=NEW.account_id
      AND COALESCE(o.server_wire_name,'INBOX')=COALESCE(NEW.server_wire_name,'INBOX')
      AND o.uid_validity=NEW.uid_validity AND o.uid=NEW.uid AND o.state<>'failed'
  ) THEN RAISE(ABORT,'remote_write_target_busy') END;
END;
CREATE TRIGGER normal_remote_flags_exclude_mutation_dispatch BEFORE UPDATE OF dispatched_at ON normal_remote_flag_operations
WHEN OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM normal_remote_mutation_operations o WHERE o.account_id=NEW.account_id
      AND COALESCE(o.server_wire_name,'INBOX')=COALESCE(NEW.server_wire_name,'INBOX')
      AND o.uid_validity=NEW.uid_validity AND o.uid=NEW.uid AND o.state<>'failed'
  ) THEN RAISE(ABORT,'remote_write_target_busy') END;
END;
