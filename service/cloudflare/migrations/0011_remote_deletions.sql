-- Expand only. Historical cache rows deliberately do not acquire source identity.
ALTER TABLE messages ADD COLUMN source_version TEXT;
ALTER TABLE messages ADD COLUMN remote_delete_enabled INTEGER NOT NULL DEFAULT 0 CHECK(remote_delete_enabled IN (0,1));

CREATE TABLE remote_deletions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  provider_id TEXT NOT NULL,
  provider_revision INTEGER NOT NULL,
  provider_endpoint TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','unknown','deleted','absent','changed')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id,request_key),
  UNIQUE(mailbox_id,remote_id,source_version)
);
CREATE INDEX remote_deletions_owner_message ON remote_deletions(user_id,mailbox_id,message_id);
