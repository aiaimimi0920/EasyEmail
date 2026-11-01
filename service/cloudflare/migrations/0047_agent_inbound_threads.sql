-- Expand only: legacy task/review rows and their foreign keys remain unchanged.
CREATE TABLE agent_inbound_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  epoch_id TEXT NOT NULL,
  seed_message_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  service_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','needs_attention','completed','archived')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id,id),
  UNIQUE(user_id,account_id,id),
  UNIQUE(user_id,account_id,seed_message_id),
  FOREIGN KEY(user_id,account_id,seed_message_id) REFERENCES agent_incoming_messages(user_id,account_id,id),
  FOREIGN KEY(user_id,service_id) REFERENCES agent_services(user_id,id)
);
CREATE INDEX agent_inbound_threads_page ON agent_inbound_threads(user_id,id);
CREATE TABLE agent_inbound_messages (
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  review_revision INTEGER NOT NULL CHECK(review_revision>=0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,account_id,message_id),
  FOREIGN KEY(user_id,account_id,thread_id) REFERENCES agent_inbound_threads(user_id,account_id,id),
  FOREIGN KEY(user_id,account_id,message_id) REFERENCES agent_incoming_messages(user_id,account_id,id)
);
CREATE INDEX agent_inbound_members ON agent_inbound_messages(user_id,thread_id,message_id);
CREATE TABLE agent_inbound_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  epoch_id TEXT NOT NULL,
  review_revision INTEGER NOT NULL,
  service_id TEXT NOT NULL,
  service_version INTEGER NOT NULL,
  confirm_restricted INTEGER NOT NULL CHECK(confirm_restricted IN (0,1)),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,account_id,message_id) REFERENCES agent_incoming_messages(user_id,account_id,id),
  FOREIGN KEY(user_id,thread_id) REFERENCES agent_inbound_threads(user_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE agent_inbound_state_operations (
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
  FOREIGN KEY(user_id,thread_id) REFERENCES agent_inbound_threads(user_id,id)
);
CREATE VIEW agent_thread_operation_history AS
  SELECT * FROM agent_thread_operations UNION ALL SELECT * FROM agent_inbound_state_operations;
-- Both old and new writers must respect the shared state-operation key and thread ID spaces.
CREATE TRIGGER agent_task_id_collision BEFORE INSERT ON agent_threads
WHEN EXISTS(SELECT 1 FROM agent_inbound_threads WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'agent_thread_id_collision'); END;
CREATE TRIGGER agent_inbound_id_collision BEFORE INSERT ON agent_inbound_threads
WHEN EXISTS(SELECT 1 FROM agent_threads WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'agent_thread_id_collision'); END;
CREATE TRIGGER agent_task_operation_collision BEFORE INSERT ON agent_thread_operations
WHEN EXISTS(SELECT 1 FROM agent_inbound_state_operations WHERE user_id=NEW.user_id AND request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'agent_thread_key_collision'); END;
CREATE TRIGGER agent_inbound_operation_collision BEFORE INSERT ON agent_inbound_state_operations
WHEN EXISTS(SELECT 1 FROM agent_thread_operations WHERE user_id=NEW.user_id AND request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'agent_thread_key_collision'); END;
CREATE TRIGGER agent_task_operation_capacity BEFORE INSERT ON agent_thread_operations
WHEN NOT EXISTS(SELECT 1 FROM agent_thread_operations WHERE user_id=NEW.user_id AND request_key=NEW.request_key)
  AND (SELECT COUNT(*) FROM agent_thread_operation_history WHERE user_id=NEW.user_id)>=10000
BEGIN SELECT RAISE(ABORT,'agent_thread_operation_limit'); END;
CREATE TRIGGER agent_inbound_operation_capacity BEFORE INSERT ON agent_inbound_state_operations
WHEN NOT EXISTS(SELECT 1 FROM agent_inbound_state_operations WHERE user_id=NEW.user_id AND request_key=NEW.request_key)
  AND (SELECT COUNT(*) FROM agent_thread_operation_history WHERE user_id=NEW.user_id)>=10000
BEGIN SELECT RAISE(ABORT,'agent_thread_operation_limit'); END;
