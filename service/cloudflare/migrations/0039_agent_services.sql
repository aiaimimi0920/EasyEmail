-- Expand only. Desktop service rows have no verified cloud-user ownership mapping.
CREATE TABLE agent_services (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  description TEXT,
  service_kind TEXT NOT NULL,
  trust_level TEXT NOT NULL CHECK (trust_level IN ('unknown','trusted','restricted','blocked')),
  status TEXT NOT NULL CHECK (status IN ('active','disabled','archived')),
  version INTEGER NOT NULL CHECK (version > 0 AND version <= 9007199254740991),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(user_id,id)
);
CREATE UNIQUE INDEX agent_services_active_email ON agent_services(user_id,email_address) WHERE deleted_at IS NULL;
CREATE INDEX agent_services_page ON agent_services(user_id,id) WHERE deleted_at IS NULL;

-- Durable receipts contain identity/version only, never names, addresses or descriptions.
CREATE TABLE agent_service_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('POST','PATCH','DELETE')),
  service_id TEXT,
  version INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(user_id,request_key),
  FOREIGN KEY(user_id,service_id) REFERENCES agent_services(user_id,id),
  CHECK (completed_at IS NULL OR (service_id IS NOT NULL AND version IS NOT NULL))
);
