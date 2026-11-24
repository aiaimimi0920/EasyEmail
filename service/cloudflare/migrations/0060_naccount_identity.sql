-- Expand-only NAccount OIDC identity bindings and single-use authorization code fence.
-- Existing users, sessions, API keys and business rows remain untouched.
CREATE TABLE user_naccount_identities (
  naccount_sub TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  email TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX user_naccount_identities_user ON user_naccount_identities(user_id);

CREATE TABLE naccount_auth_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX naccount_auth_codes_expiry ON naccount_auth_codes(expires_at);
