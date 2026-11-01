-- Human workflow is independent of the immutable task intent and delivery projections.
CREATE TABLE agent_thread_management (
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','needs_attention','completed','archived')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,thread_id),
  FOREIGN KEY(user_id,thread_id) REFERENCES agent_threads(user_id,id)
);
CREATE TABLE agent_thread_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','needs_attention','completed','archived')),
  revision INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,thread_id) REFERENCES agent_threads(user_id,id)
);
