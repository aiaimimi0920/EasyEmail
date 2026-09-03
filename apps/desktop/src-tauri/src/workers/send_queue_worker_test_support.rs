use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::AppError;
use crate::secret::fake::FakeSecretVaultAdapter;
use crate::secret::SecretVaultAdapter;
use crate::smtp::adapter::SmtpAdapter;
use crate::smtp::models::{
    SmtpConnectionProfile, SmtpConnectionTestResult, SmtpSendMessage, SmtpSendResult,
};
use crate::storage::db::open_in_memory_database;
use crate::storage::migrations::run_migrations;

pub(super) struct BlockingSmtpAdapter {
    pub(super) entered: SyncSender<()>,
    pub(super) release: Mutex<Receiver<()>>,
}

impl SmtpAdapter for BlockingSmtpAdapter {
    fn test_connection(
        &self,
        _profile: &SmtpConnectionProfile,
        _secret: &str,
    ) -> Result<SmtpConnectionTestResult, AppError> {
        Ok(SmtpConnectionTestResult {
            authenticated: true,
            capability_summary: "blocking-test".to_string(),
        })
    }

    fn send_message(
        &self,
        _profile: &SmtpConnectionProfile,
        _secret: &str,
        _message: &SmtpSendMessage,
    ) -> Result<SmtpSendResult, AppError> {
        self.entered
            .send(())
            .map_err(|error| AppError::internal("blocking_smtp_enter_failed", error.to_string()))?;
        self.release
            .lock()
            .map_err(|error| AppError::internal("blocking_smtp_lock_failed", error.to_string()))?
            .recv()
            .map_err(|error| {
                AppError::internal("blocking_smtp_release_failed", error.to_string())
            })?;
        Ok(SmtpSendResult {
            provider_message_id: Some("provider-message-1".to_string()),
        })
    }
}

pub(super) fn test_connection() -> Connection {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");
    connection
}

pub(super) fn seed_send_enabled_normal_account_with_secret(
    connection: &Connection,
    vault: &FakeSecretVaultAdapter,
) {
    connection
        .execute(
            "INSERT INTO accounts (
                id,
                scope,
                kind,
                display_name,
                primary_address,
                provider_label,
                status,
                auth_status,
                receive_status,
                send_status,
                listed_in_all_accounts,
                created_at,
                updated_at
            ) VALUES ('acct_send', 'normal', 'normal_long_lived', 'Sender', 'sender@example.test', 'Manual SMTP', 'ready', 'valid', 'enabled', 'enabled', 1, '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
            [],
        )
        .expect("insert account");
    connection
        .execute(
            "INSERT INTO mailbox_sources (
                id,
                account_id,
                source_kind,
                address,
                provider_id,
                config_json,
                credential_ref_id,
                status,
                created_at,
                updated_at
            ) VALUES ('src_smtp', 'acct_send', 'smtp', 'sender@example.test', 'smtp.example.test', '{\"host\":\"smtp.example.test\",\"port\":587,\"security\":\"starttls\",\"username\":\"sender@example.test\"}', 'cred_smtp', 'ready', '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
            [],
        )
        .expect("insert smtp source");
    connection
        .execute(
            "INSERT INTO credential_refs (
                id,
                owner_account_id,
                source_id,
                secret_backend,
                secret_key,
                credential_kind,
                auth_method,
                status,
                created_at,
                updated_at
            ) VALUES ('cred_smtp', 'acct_send', 'src_smtp', 'fake_vault', 'secret://smtp/acct_send', 'smtp_password', 'password', 'active', '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
            [],
        )
        .expect("insert credential");
    vault
        .save_secret("secret://smtp/acct_send", "app-password")
        .expect("save smtp secret");
}

pub(super) fn seed_queued_send(connection: &Connection) {
    seed_queued_send_with(
        connection,
        "msg_outgoing",
        "send_outgoing",
        "target@example.test",
        "2026-06-12T01:10:00Z",
    );
}

pub(super) fn seed_queued_send_with(
    connection: &Connection,
    message_id: &str,
    queue_id: &str,
    target_address: &str,
    now: &str,
) {
    seed_queued_send_with_due(connection, message_id, queue_id, target_address, None, now);
}

pub(super) fn seed_queued_send_with_due(
    connection: &Connection,
    message_id: &str,
    queue_id: &str,
    target_address: &str,
    next_retry_at: Option<&str>,
    now: &str,
) {
    connection
        .execute(
            "INSERT INTO messages (
                id,
                subject,
                from_address,
                snippet,
                body_text_cache,
                body_cache_state,
                classification,
                created_at,
                updated_at
            ) VALUES (?1, 'Hello', 'sender@example.test', 'Queued body', 'Queued body', 'cached', 'outgoing', ?2, ?2)",
            rusqlite::params![message_id, now],
        )
        .expect("insert outgoing message");
    connection
        .execute(
            "INSERT INTO send_queue (
                id, account_id, source_id, message_id, target_address, status, attempt_count,
                next_retry_at, created_at, updated_at
            ) VALUES (
                ?1, 'acct_send', 'src_smtp', ?2, ?3, 'queued', 0, ?4, ?5, ?5
            )",
            rusqlite::params![queue_id, message_id, target_address, next_retry_at, now],
        )
        .expect("enqueue");
}
