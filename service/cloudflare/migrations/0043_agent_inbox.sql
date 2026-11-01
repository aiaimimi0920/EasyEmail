-- Independent Agent receive namespace; no imported desktop identities or changes to normal inbox rows.
CREATE TABLE agent_inbox_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','committed','failed')),
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(account_id,request_key),
  UNIQUE(user_id,account_id,id),
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE INDEX agent_inbox_requests_owner ON agent_inbox_requests(user_id,account_id,created_at,id);
CREATE TABLE agent_inbox_state (
  account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_hash TEXT,
  epoch_id TEXT,
  uid_validity TEXT,
  after_uid INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  cache_generation INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claim_revision INTEGER,
  claim_lease_until INTEGER,
  request_id TEXT REFERENCES agent_inbox_requests(id),
  updated_at INTEGER,
  FOREIGN KEY(user_id,account_id,request_id) REFERENCES agent_inbox_requests(user_id,account_id,id),
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE TABLE agent_inbox_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES agent_inbox_requests(id),
  source_hash TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  epoch_id TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  after_uid INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staged','committed','retiring','retired')),
  item_count INTEGER NOT NULL,
  storage_bytes INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  UNIQUE(user_id,account_id,id),
  FOREIGN KEY(user_id,account_id,request_id) REFERENCES agent_inbox_requests(user_id,account_id,id),
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE INDEX agent_inbox_batches_live ON agent_inbox_batches(account_id,state);
CREATE INDEX agent_inbox_batches_cleanup ON agent_inbox_batches(state,created_at);
CREATE TABLE agent_incoming_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  uid INTEGER NOT NULL,
  raw_key TEXT NOT NULL,
  content_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  content_bytes INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  flags TEXT NOT NULL,
  summary TEXT NOT NULL,
  rfc_message_id TEXT,
  sender_address TEXT,
  association TEXT NOT NULL CHECK(association IN ('linked','unmatched','ambiguous','unknown_service','service_unavailable','invalid_headers')),
  service_id TEXT,
  thread_id TEXT,
  purged_at INTEGER,
  UNIQUE(account_id,epoch_id,uid),
  FOREIGN KEY(user_id,account_id,batch_id) REFERENCES agent_inbox_batches(user_id,account_id,id),
  FOREIGN KEY(user_id,service_id) REFERENCES agent_services(user_id,id),
  FOREIGN KEY(user_id,thread_id) REFERENCES agent_threads(user_id,id)
);
CREATE INDEX agent_incoming_page ON agent_incoming_messages(user_id,account_id,epoch_id,id);
CREATE INDEX agent_incoming_replies ON agent_incoming_messages(user_id,thread_id,observed_at,id);
CREATE INDEX agent_outgoing_rfc_fold ON agent_outgoing_messages(lower(rfc_message_id));
CREATE TABLE agent_inbox_object_deletions (
  object_key TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES agent_inbox_batches(id),
  created_at INTEGER NOT NULL,
  cleaned_at INTEGER
);
CREATE INDEX agent_inbox_object_deletions_pending ON agent_inbox_object_deletions(cleaned_at,created_at,object_key);
CREATE TABLE agent_inbox_cleanup_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  cursor TEXT
);
INSERT INTO agent_inbox_cleanup_state(id) VALUES(1);
-- Old account writers also invalidate receive authority atomically when the actual source changes.
CREATE TRIGGER agent_account_inbox_source_changed
AFTER UPDATE OF endpoint_hash,username,email_address ON agent_accounts
WHEN OLD.endpoint_hash IS NOT NEW.endpoint_hash OR OLD.username IS NOT NEW.username OR OLD.email_address IS NOT NEW.email_address
BEGIN
  UPDATE agent_inbox_state SET source_hash=NULL,epoch_id=NULL,uid_validity=NULL,after_uid=0,version=version+1,
    cache_generation=cache_generation+1,claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL,request_id=NULL,updated_at=unixepoch()
  WHERE account_id=NEW.id AND user_id=NEW.user_id;
END;
