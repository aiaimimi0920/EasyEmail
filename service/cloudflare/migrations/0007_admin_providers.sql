CREATE TABLE platform_admins (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE provider_overrides (
  id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  secret_source TEXT NOT NULL CHECK (secret_source IN ('environment', 'stored', 'none')),
  secret_cipher TEXT,
  change_token TEXT NOT NULL UNIQUE,
  updated_at INTEGER NOT NULL,
  CHECK ((secret_source = 'stored' AND secret_cipher IS NOT NULL) OR (secret_source <> 'stored' AND secret_cipher IS NULL))
);

CREATE TABLE provider_health (
  provider_id TEXT PRIMARY KEY,
  config_revision INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'error')),
  error_code TEXT,
  probe_token TEXT NOT NULL UNIQUE
);

CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  provider_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('configure', 'probe')),
  revision INTEGER NOT NULL,
  secret_action TEXT CHECK (secret_action IN ('keep', 'replace', 'clear')),
  error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_audit_page ON admin_audit(created_at DESC, id DESC);
