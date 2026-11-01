-- Expand only. Never erase outgoing guards while an upstream outcome may be unknown.
ALTER TABLE messages ADD COLUMN rfc_message_id TEXT;

CREATE TABLE outgoing_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('worker', 'binding')),
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  reply_message_id TEXT REFERENCES messages(id),
  threading TEXT NOT NULL CHECK (threading IN ('none', 'unavailable', 'submitted')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'unknown')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, request_key)
);
CREATE INDEX outgoing_user_timeline ON outgoing_messages(user_id, created_at DESC, id DESC);
CREATE INDEX outgoing_global_quota ON outgoing_messages(created_at);
CREATE INDEX outgoing_pending ON outgoing_messages(state, created_at);
