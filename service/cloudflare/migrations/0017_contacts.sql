-- Expand only: legacy local contacts have no trustworthy cloud-user ownership mapping.
CREATE TABLE contacts (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  email_address TEXT NOT NULL,
  note TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(user_id,id)
);
CREATE UNIQUE INDEX contacts_active_email ON contacts(user_id,email_address) WHERE deleted_at IS NULL;
CREATE INDEX contacts_pagination ON contacts(user_id,name_key,email_address,id) WHERE deleted_at IS NULL;
-- Receipts retain identity/version, not historical names, email addresses or notes.
CREATE TABLE contact_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('POST','PATCH','DELETE')),
  contact_id TEXT,
  version INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(user_id,request_key),
  FOREIGN KEY(user_id,contact_id) REFERENCES contacts(user_id,id)
);
