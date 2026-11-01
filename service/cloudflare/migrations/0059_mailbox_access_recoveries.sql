-- Expand-only proof-of-credential ledger. No token or reversible request material is stored here.
-- Mailbox identity and the immutable receipt are committed in one application D1 batch.
CREATE TABLE mailbox_access_recoveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  address TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('imported','restored','refreshed')),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,request_key)
);
CREATE INDEX mailbox_access_recoveries_owner ON mailbox_access_recoveries(user_id,mailbox_id);
