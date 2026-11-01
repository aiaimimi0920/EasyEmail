-- Manual classification is an overlay. Original MIME/header association remains immutable.
CREATE UNIQUE INDEX agent_incoming_owned ON agent_incoming_messages(user_id,account_id,id);
CREATE TABLE agent_incoming_reviews (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('attention','linked','dismissed')),
  thread_id TEXT,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,account_id,message_id),
  CHECK((state='linked' AND thread_id IS NOT NULL) OR (state<>'linked' AND thread_id IS NULL)),
  FOREIGN KEY(user_id,account_id,message_id) REFERENCES agent_incoming_messages(user_id,account_id,id),
  FOREIGN KEY(user_id,thread_id) REFERENCES agent_threads(user_id,id)
);
CREATE TABLE agent_review_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  epoch_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('attention','linked','dismissed')),
  thread_id TEXT,
  revision INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,account_id,message_id) REFERENCES agent_incoming_messages(user_id,account_id,id),
  FOREIGN KEY(user_id,thread_id) REFERENCES agent_threads(user_id,id)
);
CREATE INDEX agent_review_operations_owner ON agent_review_operations(user_id,account_id,request_key);
