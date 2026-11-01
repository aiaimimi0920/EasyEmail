-- Expand only: private platform locations, not remote mailbox folders.
CREATE TABLE folders (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('blue','green','orange','purple','gray')),
  parent_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,id),
  FOREIGN KEY(user_id,parent_id) REFERENCES folders(user_id,id)
);
CREATE UNIQUE INDEX folders_active_name ON folders(user_id,name_key) WHERE deleted_at IS NULL;
CREATE INDEX folders_parent ON folders(user_id,parent_id) WHERE deleted_at IS NULL;
CREATE TABLE message_folders (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  PRIMARY KEY(user_id,message_id),
  FOREIGN KEY(user_id,message_id) REFERENCES messages(user_id,id),
  FOREIGN KEY(user_id,folder_id) REFERENCES folders(user_id,id)
);
CREATE INDEX message_folders_filter ON message_folders(user_id,folder_id,message_id);
