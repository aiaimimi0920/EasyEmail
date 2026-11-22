-- Content tombstones and object deletion intents preserve receive identity and receipts.
ALTER TABLE normal_inbox_messages ADD COLUMN purged_at INTEGER;
ALTER TABLE normal_inbox_messages ADD COLUMN purge_run_id TEXT REFERENCES retention_runs(id);
ALTER TABLE normal_inbox_state ADD COLUMN cache_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE normal_inbox_batches ADD COLUMN released_items INTEGER NOT NULL DEFAULT 0 CHECK(released_items BETWEEN 0 AND item_count);
ALTER TABLE normal_inbox_batches ADD COLUMN released_bytes INTEGER NOT NULL DEFAULT 0 CHECK(released_bytes BETWEEN 0 AND storage_bytes);
ALTER TABLE normal_inbox_batches ADD COLUMN retired_at INTEGER;
ALTER TABLE normal_inbox_batches ADD COLUMN retired_run_id TEXT REFERENCES retention_runs(id);
ALTER TABLE retention_runs ADD COLUMN purged_normal_messages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retention_runs ADD COLUMN retired_normal_batches INTEGER NOT NULL DEFAULT 0;
CREATE INDEX normal_inbox_retention_age ON normal_inbox_messages(purged_at,observed_at,id);
CREATE INDEX normal_inbox_purge_run ON normal_inbox_messages(purge_run_id,batch_id);
CREATE INDEX normal_inbox_retire_age ON normal_inbox_batches(status,retired_at,created_at,id);
CREATE INDEX normal_inbox_retire_run ON normal_inbox_batches(retired_run_id);
CREATE INDEX normal_reply_draft_pin ON drafts(normal_reply_message_id,state);
CREATE INDEX normal_reply_pending_pin ON normal_outgoing_messages(reply_message_id,state);
CREATE TABLE normal_inbox_object_deletions (
  object_key TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES normal_inbox_batches(id),
  message_id TEXT REFERENCES normal_inbox_messages(id),
  run_id TEXT NOT NULL REFERENCES retention_runs(id),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152),
  created_at INTEGER NOT NULL,
  cleaned_at INTEGER
);
CREATE INDEX normal_inbox_object_pending ON normal_inbox_object_deletions(cleaned_at,created_at,object_key);
CREATE TABLE normal_inbox_cleanup_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT);
INSERT INTO normal_inbox_cleanup_state(id,cursor) VALUES(1,NULL);
