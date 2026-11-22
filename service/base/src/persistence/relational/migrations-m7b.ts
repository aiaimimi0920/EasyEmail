export const MAIL_M7B_AGENT_MIGRATION_SQL = `
CREATE TABLE mail_agent_services (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  description TEXT,
  service_kind TEXT NOT NULL,
  trust_level TEXT NOT NULL CHECK(trust_level IN ('unknown', 'trusted', 'restricted', 'blocked')),
  default_sender_account_id TEXT REFERENCES mail_accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'disabled', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX idx_mail_agent_services_email_active
ON mail_agent_services(lower(email_address))
WHERE deleted_at IS NULL;

CREATE INDEX idx_mail_agent_services_created
ON mail_agent_services(created_at ASC, id ASC)
WHERE deleted_at IS NULL;

CREATE TABLE mail_agent_threads (
  id TEXT PRIMARY KEY,
  agent_service_id TEXT NOT NULL REFERENCES mail_agent_services(id) ON DELETE CASCADE,
  sender_account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'sent', 'awaiting_reply', 'in_progress', 'completed', 'failed', 'expired', 'needs_attention', 'archived')),
  last_outgoing_message_id TEXT REFERENCES mail_messages(id) ON DELETE SET NULL,
  last_incoming_message_id TEXT REFERENCES mail_messages(id) ON DELETE SET NULL,
  correlation_key TEXT NOT NULL,
  idempotency_key TEXT,
  payload_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX idx_mail_agent_threads_idempotency
ON mail_agent_threads(sender_account_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_mail_agent_threads_updated
ON mail_agent_threads(updated_at DESC, id DESC);

CREATE INDEX idx_mail_agent_threads_status
ON mail_agent_threads(status, updated_at DESC, id DESC);

CREATE TABLE mail_agent_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES mail_agent_threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('outgoing', 'incoming')),
  semantic_role TEXT NOT NULL,
  parsed_status TEXT,
  parsed_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_mail_agent_messages_thread_message_direction
ON mail_agent_messages(thread_id, message_id, direction);

CREATE UNIQUE INDEX idx_mail_agent_messages_incoming_message
ON mail_agent_messages(message_id, direction)
WHERE direction = 'incoming';

CREATE INDEX idx_mail_agent_messages_thread_created
ON mail_agent_messages(thread_id, created_at ASC, id ASC);
`;
