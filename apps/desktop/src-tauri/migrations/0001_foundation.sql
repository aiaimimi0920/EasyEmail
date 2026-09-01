CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('normal', 'agent', 'system')),
  kind TEXT NOT NULL CHECK (kind IN ('normal_long_lived', 'normal_upgraded_temp', 'anonymous_virtual', 'agent_owned')),
  display_name TEXT NOT NULL,
  primary_address TEXT,
  provider_label TEXT,
  status TEXT NOT NULL,
  auth_status TEXT NOT NULL,
  receive_status TEXT NOT NULL,
  send_status TEXT NOT NULL,
  listed_in_all_accounts INTEGER NOT NULL CHECK (listed_in_all_accounts IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_anonymous_virtual
ON accounts(kind)
WHERE kind = 'anonymous_virtual' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_normal_visible
ON accounts(scope, listed_in_all_accounts, deleted_at);

CREATE TABLE IF NOT EXISTS mailbox_sources (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  source_kind TEXT NOT NULL,
  address TEXT,
  provider_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  credential_ref_id TEXT,
  status TEXT NOT NULL,
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS credential_refs (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT,
  source_id TEXT,
  secret_backend TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  credential_kind TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  FOREIGN KEY(owner_account_id) REFERENCES accounts(id),
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id)
);

CREATE TABLE IF NOT EXISTS mail_folders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  provider_folder_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  path TEXT NOT NULL,
  delimiter TEXT,
  folder_kind TEXT NOT NULL,
  last_seen_uid TEXT,
  sync_cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_folders_source_provider
ON mail_folders(source_id, provider_folder_id);

CREATE TABLE IF NOT EXISTS temp_mailboxes (
  id TEXT PRIMARY KEY,
  email_address TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  domain TEXT,
  local_part TEXT,
  easyemail_mailbox_id TEXT,
  source_id TEXT,
  visibility_state TEXT NOT NULL CHECK (visibility_state IN ('anonymous', 'upgraded', 'archived', 'hidden')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'expiring', 'expired', 'receive_unavailable', 'provider_unavailable', 'history_only')),
  lease_expires_at TEXT,
  renewable_until TEXT,
  last_fetch_at TEXT,
  last_success_at TEXT,
  upgraded_account_id TEXT,
  raw_provider_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id),
  FOREIGN KEY(upgraded_account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_temp_mailboxes_visibility
ON temp_mailboxes(visibility_state, lifecycle_state);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  rfc_message_id TEXT,
  thread_key TEXT,
  subject TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  date_sent TEXT,
  date_received TEXT,
  snippet TEXT NOT NULL DEFAULT '',
  body_text_cache TEXT,
  body_html_cache TEXT,
  body_cache_state TEXT NOT NULL DEFAULT 'headers_only',
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  size_bytes INTEGER,
  classification TEXT NOT NULL DEFAULT 'normal',
  security_flags TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_rfc_message_id
ON messages(rfc_message_id);

CREATE TABLE IF NOT EXISTS message_sources (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  account_id TEXT,
  folder_id TEXT,
  temp_mailbox_id TEXT,
  provider_message_id TEXT,
  imap_uid TEXT,
  imap_uidvalidity TEXT,
  easyemail_message_id TEXT,
  received_address TEXT,
  flags_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id),
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(folder_id) REFERENCES mail_folders(id),
  FOREIGN KEY(temp_mailbox_id) REFERENCES temp_mailboxes(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_sources_easyemail_unique
ON message_sources(temp_mailbox_id, easyemail_message_id)
WHERE temp_mailbox_id IS NOT NULL AND easyemail_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_sources_imap_unique
ON message_sources(source_id, folder_id, imap_uid)
WHERE source_id IS NOT NULL AND folder_id IS NOT NULL AND imap_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_queue (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'auth_failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id),
  FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_send_queue_due
ON send_queue(status, next_retry_at, created_at);

CREATE TABLE IF NOT EXISTS agent_services (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  description TEXT,
  service_kind TEXT NOT NULL,
  trust_level TEXT NOT NULL CHECK (trust_level IN ('unknown', 'trusted', 'restricted', 'blocked')),
  default_sender_account_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(default_sender_account_id) REFERENCES accounts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_services_email_active
ON agent_services(email_address)
WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT PRIMARY KEY,
  agent_service_id TEXT NOT NULL,
  sender_account_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'awaiting_reply', 'in_progress', 'completed', 'failed', 'expired', 'needs_attention', 'archived')),
  last_outgoing_message_id TEXT,
  last_incoming_message_id TEXT,
  correlation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(agent_service_id) REFERENCES agent_services(id),
  FOREIGN KEY(sender_account_id) REFERENCES accounts(id),
  FOREIGN KEY(last_outgoing_message_id) REFERENCES messages(id),
  FOREIGN KEY(last_incoming_message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_threads_status
ON agent_threads(status, updated_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  semantic_role TEXT NOT NULL,
  parsed_status TEXT,
  parsed_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(thread_id) REFERENCES agent_threads(id),
  FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_thread_message_direction
ON agent_messages(thread_id, message_id, direction);

CREATE TABLE IF NOT EXISTS sync_states (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  folder_id TEXT,
  sync_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  last_started_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id)
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  received_address TEXT NOT NULL,
  code TEXT NOT NULL,
  issuer_hint TEXT,
  target_service_hint TEXT,
  confidence REAL NOT NULL,
  expires_at TEXT,
  extracted_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_verification_codes_recent
ON verification_codes(extracted_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
