CREATE TABLE account_revisions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
  updated_at INTEGER NOT NULL
);

CREATE TABLE account_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('disable', 'enable', 'revoke-credentials', 'password-change')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, revision)
);
CREATE INDEX account_audit_page ON account_audit(id);
CREATE INDEX account_audit_user ON account_audit(user_id, id);
CREATE INDEX api_keys_unrevoked_user ON api_keys(user_id) WHERE revoked_at IS NULL;
