-- Expand only. Binary content lives in a private optional R2 binding, never in JSON/D1.
ALTER TABLE drafts ADD COLUMN attachments_json TEXT CHECK (attachments_json IS NULL OR json_valid(attachments_json));
ALTER TABLE outgoing_messages ADD COLUMN attachments_json TEXT CHECK (attachments_json IS NULL OR json_valid(attachments_json));
CREATE TABLE outbox_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 2097152),
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','ready','deleted','expired')),
  object_version TEXT,
  object_etag TEXT,
  upload_token TEXT,
  upload_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  cleanup_at INTEGER,
  UNIQUE(user_id,request_key)
);
CREATE INDEX outbox_user_capacity ON outbox_assets(user_id,cleanup_at,created_at);
CREATE INDEX outbox_global_capacity ON outbox_assets(cleanup_at,created_at);
CREATE INDEX outbox_expiry ON outbox_assets(expires_at,id);
CREATE INDEX outbox_user_uploads ON outbox_assets(user_id,created_at);
CREATE INDEX outbox_global_uploads ON outbox_assets(created_at);
CREATE TABLE outbox_cleanup_state (id TEXT PRIMARY KEY CHECK (id='inventory'), cursor TEXT);
INSERT INTO outbox_cleanup_state(id,cursor) VALUES('inventory',NULL);
