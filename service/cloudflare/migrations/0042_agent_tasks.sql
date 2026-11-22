-- Expand Agent task ownership without importing desktop records or reusing normal jobs.
CREATE TABLE agent_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  service_id TEXT NOT NULL,
  service_version INTEGER NOT NULL,
  sender_account_id TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  smtp_revision INTEGER NOT NULL,
  endpoint_hash TEXT NOT NULL,
  confirm_restricted INTEGER NOT NULL CHECK (confirm_restricted IN (0,1)),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  correlation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('draft','awaiting_reply','failed','needs_attention','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id,id),
  UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,service_id) REFERENCES agent_services(user_id,id),
  FOREIGN KEY(user_id,sender_account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE INDEX agent_threads_page ON agent_threads(user_id,id);
CREATE TABLE agent_outgoing_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  rfc_message_id TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  recipient_count INTEGER NOT NULL CHECK (recipient_count=1),
  state TEXT NOT NULL CHECK (state IN ('queued','pending','accepted','rejected','unknown','cancelled','not_sent')),
  dispatch_token TEXT,
  submitted_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  content_purged_at INTEGER,
  UNIQUE(user_id,thread_id,id),
  FOREIGN KEY(user_id,thread_id) REFERENCES agent_threads(user_id,id)
);
CREATE INDEX agent_outgoing_pending ON agent_outgoing_messages(state,submitted_at);
CREATE TABLE agent_thread_messages (
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  outgoing_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction='outgoing'),
  semantic_role TEXT NOT NULL CHECK (semantic_role='task_request'),
  parsed_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,thread_id,outgoing_id),
  FOREIGN KEY(user_id,thread_id,outgoing_id) REFERENCES agent_outgoing_messages(user_id,thread_id,id)
);
CREATE TABLE agent_send_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  outgoing_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('queued','submitted','cancelled','failed')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id,thread_id,outgoing_id) REFERENCES agent_outgoing_messages(user_id,thread_id,id)
);
CREATE INDEX agent_jobs_due ON agent_send_jobs(state,next_attempt_at,id);
-- This view owns no stored data. Replace only its definition to include actual Agent reservations.
DROP VIEW send_recipient_charges;
CREATE VIEW send_recipient_charges AS
  SELECT user_id,recipient_count,created_at FROM outgoing_messages
  UNION ALL SELECT user_id,recipient_count,created_at FROM normal_outgoing_messages
  UNION ALL SELECT user_id,recipient_count,submitted_at AS created_at FROM agent_outgoing_messages WHERE submitted_at IS NOT NULL;
