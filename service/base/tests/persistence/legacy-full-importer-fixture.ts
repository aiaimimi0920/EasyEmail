import { DatabaseSync } from "node:sqlite";

const FOUNDATION_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  primary_address TEXT,
  provider_label TEXT,
  status TEXT NOT NULL,
  auth_status TEXT NOT NULL,
  receive_status TEXT NOT NULL,
  send_status TEXT NOT NULL,
  listed_in_all_accounts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE mailbox_sources (
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
  updated_at TEXT NOT NULL
);

CREATE TABLE credential_refs (
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
  last_verified_at TEXT
);

CREATE TABLE mail_folders (
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
  updated_at TEXT NOT NULL
);

CREATE TABLE temp_mailboxes (
  id TEXT PRIMARY KEY,
  email_address TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  domain TEXT,
  local_part TEXT,
  easyemail_mailbox_id TEXT,
  source_id TEXT,
  visibility_state TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  lease_expires_at TEXT,
  renewable_until TEXT,
  last_fetch_at TEXT,
  last_success_at TEXT,
  upgraded_account_id TEXT,
  raw_provider_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE messages (
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
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  classification TEXT NOT NULL DEFAULT 'normal',
  security_flags TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE message_sources (
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
  last_seen_at TEXT NOT NULL
);

CREATE TABLE send_queue (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_address TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE agent_services (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  description TEXT,
  service_kind TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  default_sender_account_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE agent_threads (
  id TEXT PRIMARY KEY,
  agent_service_id TEXT NOT NULL,
  sender_account_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  last_outgoing_message_id TEXT,
  last_incoming_message_id TEXT,
  correlation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  semantic_role TEXT NOT NULL,
  parsed_status TEXT,
  parsed_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE sync_states (
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
  last_error_message TEXT
);

CREATE TABLE verification_codes (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  received_address TEXT NOT NULL,
  code TEXT NOT NULL,
  issuer_hint TEXT,
  target_service_hint TEXT,
  confidence REAL NOT NULL,
  expires_at TEXT,
  extracted_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function createLegacyDatabaseAtVersion(filePath: string, maxVersion = 10): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec(FOUNDATION_SQL);
    if (maxVersion >= 2) {
      db.exec(`
        CREATE TABLE sender_avatar_cache (
          cache_key TEXT PRIMARY KEY,
          sender_domain TEXT NOT NULL,
          normalized_sender TEXT,
          source_kind TEXT NOT NULL,
          image_mime TEXT,
          image_bytes BLOB,
          remote_url TEXT,
          fallback_text TEXT NOT NULL,
          status TEXT NOT NULL,
          auth_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT,
          fetched_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE contact_avatar_overrides (
          sender_key TEXT PRIMARY KEY,
          normalized_sender TEXT NOT NULL,
          sender_domain TEXT NOT NULL,
          image_mime TEXT NOT NULL,
          image_bytes BLOB NOT NULL,
          display_name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
    if (maxVersion >= 3) {
      db.exec(`
        ALTER TABLE send_queue ADD COLUMN cc_addresses_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE send_queue ADD COLUMN bcc_addresses_json TEXT NOT NULL DEFAULT '[]';
      `);
    }
    if (maxVersion >= 4) {
      db.exec(`
        CREATE TABLE contacts (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          email_address TEXT NOT NULL UNIQUE,
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
    if (maxVersion >= 5) {
      db.exec(`
        CREATE TABLE newsletter_subscription_overrides (
          account_id TEXT NOT NULL,
          subscription_key TEXT NOT NULL,
          hidden INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(account_id, subscription_key)
        );
      `);
    }
    if (maxVersion >= 6) {
      db.exec(`
        CREATE TABLE mail_taxonomy_items (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          color TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          system INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(kind, normalized_name)
        );
      `);
    }
    if (maxVersion >= 8) {
      db.exec("ALTER TABLE mail_taxonomy_items ADD COLUMN parent_id TEXT;");
    }
    for (let version = 1; version <= maxVersion; version += 1) {
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        version,
        `migration-${version}`,
        "2026-06-12T00:00:00Z",
      );
    }
  } finally {
    db.close();
  }
}

export function seedFullV10LegacyData(filePath: string, secretCanary: string): void {
  const db = new DatabaseSync(filePath);
  try {
    const t = "2026-08-01T10:00:00Z";
    db.prepare(`
      INSERT INTO accounts VALUES
      ('acct_anon', 'system', 'anonymous_virtual', 'Anonymous', NULL, NULL,
       'ready', 'not_required', 'enabled', 'unsupported', 1, ?, ?, NULL),
      ('acct_work', 'normal', 'normal_long_lived', 'Work Mail', 'work@example.com', 'Manual IMAP',
       'ready', 'valid', 'enabled', 'enabled', 1, ?, ?, NULL),
      ('acct_missing_vault', 'normal', 'normal_long_lived', 'Missing Vault', 'missing@example.com', 'Manual IMAP',
       'ready', 'valid', 'enabled', 'enabled', 1, ?, ?, NULL),
      ('acct_promoted', 'normal', 'normal_upgraded_temp', 'Promoted Temp', 'promo@temp.example.com', 'Cloudflare Temp',
       'ready', 'not_required', 'enabled', 'unsupported', 1, ?, ?, NULL),
      ('acct_agent', 'agent', 'agent_owned', 'Ops Agent', 'agent@example.com', 'Agent IMAP',
       'ready', 'valid', 'enabled', 'enabled', 0, ?, ?, NULL)
    `).run(t, t, t, t, t, t, t, t, t, t);

    db.prepare(`
      INSERT INTO mailbox_sources (
        id, account_id, source_kind, address, provider_id, config_json,
        status, last_sync_at, last_success_at, created_at, updated_at
      ) VALUES
      ('src_work_imap', 'acct_work', 'imap', 'work@example.com', 'imap.example.com',
       '{"host":"imap.example.com","port":993,"security":"ssl","username":"work@example.com"}',
       'ready', ?, ?, ?, ?),
      ('src_work_smtp', 'acct_work', 'smtp', 'work@example.com', 'smtp.example.com',
       '{"host":"smtp.example.com","port":465,"security":"tls","username":"work@example.com"}',
       'ready', NULL, NULL, ?, ?),
      ('src_missing_imap', 'acct_missing_vault', 'imap', 'missing@example.com', 'imap.example.com',
       '{"host":"imap.example.com","port":993,"security":"tls","username":"missing@example.com"}',
       'ready', NULL, NULL, ?, ?),
      ('src_agent_imap', 'acct_agent', 'imap', 'agent@example.com', 'imap.example.com',
       '{"host":"imap.example.com","port":993,"security":"tls","username":"agent@example.com"}',
       'ready', ?, ?, ?, ?),
      ('src_agent_smtp', 'acct_agent', 'smtp', 'agent@example.com', 'smtp.example.com',
       '{"host":"smtp.example.com","port":587,"security":"starttls","username":"agent@example.com"}',
       'ready', NULL, NULL, ?, ?),
      ('src_temp_1', NULL, 'easyemail', 'anon@temp.example.com', 'gptmail', '{}', 'ready', NULL, NULL, ?, ?),
      ('src_temp_2', 'acct_promoted', 'easyemail', 'promo@temp.example.com', 'cloudflare_temp_email', '{}', 'ready', NULL, NULL, ?, ?)
    `).run(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t);

    db.prepare(`
      INSERT INTO credential_refs VALUES
      ('cred_work_imap', 'acct_work', 'src_work_imap', 'secret_vault', 'secret://imap/acct_work',
       'imap_password', 'password', 'active', ?, ?, ?),
      ('cred_work_smtp', 'acct_work', 'src_work_smtp', 'secret_vault', 'secret://smtp/acct_work',
       'smtp_password', 'password', 'active', ?, ?, ?),
      ('cred_missing_imap', 'acct_missing_vault', 'src_missing_imap', 'secret_vault', 'secret://imap/acct_missing_vault',
       'imap_password', 'password', 'active', ?, ?, NULL),
      ('cred_agent_smtp', 'acct_agent', 'src_agent_smtp', 'windows_credential_manager', 'ref:v1:desktop/11111111222233334444555566667777',
       'smtp_password', 'password', 'active', ?, ?, ?)
    `).run(t, t, t, t, t, t, t, t, t, t, t);

    db.prepare(`
      INSERT INTO temp_mailboxes (
        id, email_address, provider_id, provider_label, easyemail_mailbox_id, source_id,
        visibility_state, lifecycle_state, lease_expires_at, upgraded_account_id,
        raw_provider_snapshot_json, created_at, updated_at, archived_at
      ) VALUES
      ('tmp_anon_1', 'anon@temp.example.com', 'gptmail', 'GPTMail', 'ee_1', 'src_temp_1',
       'anonymous', 'active', '2026-12-31T00:00:00Z', NULL, ?, ?, ?, NULL),
      ('tmp_promo_1', 'promo@temp.example.com', 'cloudflare_temp_email', 'Cloudflare Temp', 'ee_2', 'src_temp_2',
       'upgraded', 'active', '2026-12-31T00:00:00Z', 'acct_promoted', '{}', ?, ?, NULL)
    `).run(JSON.stringify({ jwt: secretCanary, password: secretCanary }), t, t, t, t);

    db.prepare(`
      INSERT INTO mail_folders VALUES
      ('fld_work_inbox', 'acct_work', 'src_work_imap', 'INBOX', 'Inbox', 'INBOX', '/', 'inbox', '42', NULL, ?, ?)
    `).run(t, t);

    db.prepare(`
      INSERT INTO contacts VALUES
      ('cnt_alice', 'Alice Chen', 'alice@example.com', 'Engineering lead', ?, ?)
    `).run(t, t);

    db.prepare(`
      INSERT INTO mail_taxonomy_items (
        id, kind, name, normalized_name, color, sort_order, system, created_at, updated_at, parent_id
      ) VALUES
      ('tax_root', 'folder', 'Projects', 'projects', '#d9ff38', 1, 0, ?, ?, NULL),
      ('tax_child', 'folder', 'Alpha', 'alpha', '#06b6d4', 2, 0, ?, ?, 'tax_root'),
      ('tax_label', 'label', 'VIP', 'vip', '#22c55e', 1, 0, ?, ?, NULL)
    `).run(t, t, t, t, t, t);

    db.prepare(`
      INSERT INTO messages (
        id, rfc_message_id, thread_key, subject, from_address, from_name,
        date_sent, date_received, snippet, body_text_cache, body_html_cache,
        body_cache_state, has_attachments, classification, security_flags,
        created_at, updated_at, deleted_at
      ) VALUES
      ('msg_work_1', '<w1@example.com>', '<w1@example.com>', 'Your login code 849201', 'alice@example.com', 'Alice',
       ?, ?, 'Code 849201', 'Your login code is 849201', '<p>Your login code is <b>849201</b></p>',
       'cached', 0, 'verification', '{}', ?, ?, NULL),
      ('msg_news_1', '<n1@news.example.com>', '<n1@news.example.com>', 'Weekly Digest', 'digest@news.example.com', 'Digest',
       ?, ?, 'Weekly digest', 'Digest body', NULL,
       'cached', 0, 'newsletter', '{"list_id":"digest.news.example.com","unsubscribe_methods":["https://news.example.com/unsub"]}', ?, ?, NULL),
      ('msg_out_sending', '<out1@example.com>', '<out1@example.com>', 'Interrupted Outbound', 'work@example.com', 'Work',
       ?, ?, 'Interrupted', 'Outbound text', NULL, 'cached', 0, 'outgoing', '{}', ?, ?, NULL),
      ('msg_agent_out', '<ag1@example.com>', 'corr_ag_1', 'Run audit', 'agent@example.com', 'Ops Agent',
       ?, ?, 'Run audit', 'Please audit cluster', NULL, 'cached', 0, 'outgoing', '{}', ?, ?, NULL)
    `).run(t, t, t, t, t, t, t, t, t, t, t, t, t, t, t, t);

    db.prepare(`
      INSERT INTO message_sources (
        id, message_id, source_id, account_id, folder_id, temp_mailbox_id,
        provider_message_id, imap_uid, imap_uidvalidity, easyemail_message_id,
        received_address, flags_json, first_seen_at, last_seen_at
      ) VALUES
      ('msrc_1', 'msg_work_1', 'src_work_imap', 'acct_work', 'fld_work_inbox', NULL,
       'INBOX:42', '42', '1001', NULL, 'work@example.com',
       '{"read":true,"starred":true,"local_folder":"inbox","labels":["VIP"]}', ?, ?),
      ('msrc_2', 'msg_news_1', 'src_work_imap', 'acct_work', 'fld_work_inbox', NULL,
       'INBOX:43', '43', '1001', NULL, 'work@example.com',
       '{"read":false,"local_folder":"inbox","labels":["newsletters"]}', ?, ?),
      ('msrc_3', 'msg_out_sending', 'src_work_smtp', 'acct_work', NULL, NULL,
       NULL, NULL, NULL, NULL, 'work@example.com', '{"read":true,"local_folder":"sent"}', ?, ?),
      ('msrc_4', 'msg_agent_out', 'src_agent_smtp', 'acct_agent', NULL, NULL,
       NULL, NULL, NULL, NULL, 'agent@example.com', '{"read":true,"local_folder":"sent"}', ?, ?)
    `).run(t, t, t, t, t, t, t, t);

    db.prepare(`
      INSERT INTO verification_codes VALUES
      ('vc_1', 'msg_work_1', 'normal', 'work@example.com', '849201', 'Example', 'Portal', 0.96, NULL, ?)
    `).run(t);

    db.prepare(`
      INSERT INTO newsletter_subscription_overrides VALUES
      ('acct_work', 'list:digest.news.example.com', 1, ?)
    `).run(t);

    db.prepare(`
      INSERT INTO send_queue (
        id, account_id, source_id, message_id, target_address, cc_addresses_json, bcc_addresses_json,
        status, attempt_count, next_retry_at, last_error_code, last_error_message, created_at, updated_at, sent_at
      ) VALUES
      ('sq_sending_1', 'acct_work', 'src_work_smtp', 'msg_out_sending', 'bob@example.com', '["cc@example.com"]', '[]',
       'sending', 1, NULL, NULL, NULL, ?, ?, NULL),
      ('sq_sent_agent', 'acct_agent', 'src_agent_smtp', 'msg_agent_out', 'bot-svc@example.com', '[]', '[]',
       'sent', 1, NULL, NULL, NULL, ?, ?, ?)
    `).run(t, t, t, t, t);

    db.prepare(`
      INSERT INTO agent_services VALUES
      ('asvc_1', 'Audit Bot', 'bot-svc@example.com', 'Cluster auditor', 'auditor', 'trusted', 'acct_agent', 'active', ?, ?, NULL)
    `).run(t, t);

    db.prepare(`
      INSERT INTO agent_threads VALUES
      ('athr_1', 'asvc_1', 'acct_agent', 'Run audit', 'awaiting_reply', 'msg_agent_out', NULL, 'corr_ag_1', ?, ?, NULL)
    `).run(t, t);

    db.prepare(`
      INSERT INTO agent_messages VALUES
      ('amsg_1', 'athr_1', 'msg_agent_out', 'outgoing', 'task_request', 'sent', '{"task":"audit"}', ?)
    `).run(t);

    db.prepare(`
      INSERT INTO app_settings VALUES
      ('easyemail.connection', ?, ?),
      ('sender_avatar.settings', '{"remote_enabled":false,"bimi_enabled":true,"favicon_enabled":false,"auth_enabled":true}', ?)
    `).run(JSON.stringify({ service_url: `https://user:${secretCanary}@mail.example.com:8443/` }), t, t);

    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
    db.prepare(`
      INSERT INTO sender_avatar_cache VALUES
      ('domain:example.com', 'example.com', 'alice@example.com', 'favicon', 'image/png', ?, 'https://example.com/icon.png', 'AL', 'ok', '{}', NULL, ?, '2026-12-31T00:00:00Z', ?, ?),
      ('domain:evil.test', 'evil.test', 'x@evil.test', 'bimi', 'image/svg+xml', ?, 'https://evil.test/logo.svg', 'EV', 'ok', '{}', NULL, ?, '2026-12-31T00:00:00Z', ?, ?)
    `).run(tinyPng, t, t, t, evilSvg, t, t, t);

    db.prepare(`
      INSERT INTO contact_avatar_overrides VALUES
      ('sender:alice@example.com', 'alice@example.com', 'example.com', 'image/png', ?, 'Alice Chen', ?, ?)
    `).run(tinyPng, t, t);
  } finally {
    db.close();
  }
}
