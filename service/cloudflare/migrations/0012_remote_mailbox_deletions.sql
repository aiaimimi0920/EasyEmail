-- Expand only. Keep remote receipts separate from cached content and platform lifecycle.
CREATE TABLE remote_mailbox_deletions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  mailbox_id TEXT NOT NULL UNIQUE REFERENCES mailboxes(id),
  provider_id TEXT NOT NULL,
  provider_revision INTEGER NOT NULL,
  provider_endpoint TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  address TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','unknown','deleted','absent','changed')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id,request_key)
);
CREATE INDEX remote_mailbox_deletions_owner ON remote_mailbox_deletions(user_id,mailbox_id);
