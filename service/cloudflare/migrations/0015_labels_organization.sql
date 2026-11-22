-- Expand only: existing messages, flags, credentials and API Key scopes remain unchanged.
CREATE TABLE labels (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('blue','green','orange','purple','gray')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,id)
);
CREATE UNIQUE INDEX labels_active_name ON labels(user_id,name_key) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX messages_owner_identity ON messages(user_id,id);
CREATE TABLE message_labels (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY(user_id,message_id,label_id),
  FOREIGN KEY(user_id,message_id) REFERENCES messages(user_id,id),
  FOREIGN KEY(user_id,label_id) REFERENCES labels(user_id,id)
);
CREATE INDEX message_labels_filter ON message_labels(user_id,label_id,message_id);
CREATE TABLE organization_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  required_scopes TEXT NOT NULL CHECK (json_valid(required_scopes)),
  message_count INTEGER NOT NULL CHECK (message_count BETWEEN 1 AND 50),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(user_id,request_key)
);
