-- Expand only: preserve the M1 identity and mailbox metadata tables.
ALTER TABLE mailboxes ADD COLUMN credential_cipher TEXT;
ALTER TABLE mailboxes ADD COLUMN sync_token TEXT;
ALTER TABLE mailboxes ADD COLUMN sync_lease_until INTEGER;
ALTER TABLE mailboxes ADD COLUMN synced_at INTEGER;
ALTER TABLE mailboxes ADD COLUMN sync_error TEXT;
ALTER TABLE mailboxes ADD COLUMN next_page INTEGER;
ALTER TABLE mailboxes ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mailboxes ADD COLUMN sync_missing INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX mailboxes_address ON mailboxes(address COLLATE NOCASE);

CREATE TABLE mailbox_creations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  mailbox_id TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'unknown')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, request_key)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  remote_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  attachments TEXT NOT NULL CHECK (json_valid(attachments)),
  received_at INTEGER,
  observed_at INTEGER NOT NULL,
  UNIQUE(mailbox_id, fingerprint)
);
CREATE INDEX messages_owner_page ON messages(user_id, mailbox_id, id);
CREATE INDEX messages_received ON messages(user_id, mailbox_id, received_at DESC);
