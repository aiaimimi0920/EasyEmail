CREATE TABLE normal_inbox_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES normal_accounts(id),
  request_key TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT,
  UNIQUE(account_id,request_key)
);
CREATE INDEX normal_inbox_requests_account ON normal_inbox_requests(account_id,created_at DESC,id);
ALTER TABLE normal_inbox_state ADD COLUMN request_id TEXT REFERENCES normal_inbox_requests(id);
ALTER TABLE normal_inbox_batches ADD COLUMN request_id TEXT REFERENCES normal_inbox_requests(id);
CREATE UNIQUE INDEX normal_inbox_batches_request ON normal_inbox_batches(request_id) WHERE request_id IS NOT NULL;
ALTER TABLE normal_inbox_messages ADD COLUMN summary TEXT CHECK (summary IS NULL OR json_valid(summary));
