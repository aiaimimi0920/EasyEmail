use std::sync::Mutex;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::secret::SecretVaultAdapter;
use crate::smtp::adapter::SmtpAdapter;
use crate::smtp::models::{SmtpConnectionProfile, SmtpSendMessage, SmtpSendResult};
use crate::storage::account_repository::get_smtp_source_for_account;
use crate::storage::message_repository::get_message_detail;
use crate::storage::send_queue_repository::{
    claim_due_send_by_id, claim_next_due_scheduled_send, claim_next_due_send, get_send_queue_item,
    mark_send_auth_failed, mark_send_failed, mark_send_retry, mark_send_sent,
    mark_stale_sends_delivery_unknown, SendQueueRow,
};

const MAX_SEND_QUEUE_BATCH_LIMIT: usize = 100;
const STALE_SENDING_LEASE_SECONDS: i64 = 15 * 60;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendQueueWorkerRunResult {
    pub processed_count: usize,
    pub sent_count: usize,
    pub retry_count: usize,
    pub failed_count: usize,
}

impl SendQueueWorkerRunResult {
    fn merge(&mut self, other: Self) {
        self.processed_count += other.processed_count;
        self.sent_count += other.sent_count;
        self.retry_count += other.retry_count;
        self.failed_count += other.failed_count;
    }
}

struct PreparedSend {
    queue: SendQueueRow,
    profile: SmtpConnectionProfile,
    secret_key: String,
    message: SmtpSendMessage,
    now: String,
}

enum PreparedSendStep {
    Idle,
    Completed(SendQueueWorkerRunResult),
    Ready(Box<PreparedSend>),
}

pub fn run_send_queue_once<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let mut total = recover_stale_sends(connection, &now)?;
    let Some(queue) = claim_next_due_send(connection, &now).map_err(storage_error)? else {
        return Ok(total);
    };

    total.merge(process_claimed_send(
        connection, vault, adapter, queue, now,
    )?);
    Ok(total)
}

pub fn run_send_queue_item<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    queue_id: &str,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let mut total = recover_stale_sends(connection, &now)?;
    let Some(queue) = claim_due_send_by_id(connection, queue_id, &now).map_err(storage_error)?
    else {
        return Ok(total);
    };

    total.merge(process_claimed_send(
        connection, vault, adapter, queue, now,
    )?);
    Ok(total)
}

pub fn run_send_queue_due_batch<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    now: String,
    limit: usize,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let mut total = recover_stale_sends(connection, &now)?;
    let limit = limit.clamp(1, MAX_SEND_QUEUE_BATCH_LIMIT);

    for _ in 0..limit {
        let Some(queue) = claim_next_due_scheduled_send(connection, &now).map_err(storage_error)?
        else {
            break;
        };
        let result = process_claimed_send(connection, vault, adapter, queue, now.clone())?;
        if result.processed_count == 0 {
            break;
        }
        total.merge(result);
    }

    Ok(total)
}

pub fn run_send_queue_once_shared<V, A>(
    connection: &Mutex<Connection>,
    vault: &V,
    adapter: &A,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let (mut total, step) = {
        let connection = connection.lock().map_err(connection_lock_error)?;
        let total = recover_stale_sends(&connection, &now)?;
        let queue = claim_next_due_send(&connection, &now).map_err(storage_error)?;
        let step = prepare_send_step(&connection, queue, now)?;
        (total, step)
    };

    total.merge(finish_shared_step(connection, vault, adapter, step)?);
    Ok(total)
}

pub fn run_send_queue_item_shared<V, A>(
    connection: &Mutex<Connection>,
    vault: &V,
    adapter: &A,
    queue_id: &str,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let (mut total, step) = {
        let connection = connection.lock().map_err(connection_lock_error)?;
        let total = recover_stale_sends(&connection, &now)?;
        let queue = claim_due_send_by_id(&connection, queue_id, &now).map_err(storage_error)?;
        let step = prepare_send_step(&connection, queue, now)?;
        (total, step)
    };

    total.merge(finish_shared_step(connection, vault, adapter, step)?);
    Ok(total)
}

pub fn run_send_queue_due_batch_shared<V, A>(
    connection: &Mutex<Connection>,
    vault: &V,
    adapter: &A,
    now: String,
    limit: usize,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let mut total = {
        let connection = connection.lock().map_err(connection_lock_error)?;
        recover_stale_sends(&connection, &now)?
    };
    let limit = limit.clamp(1, MAX_SEND_QUEUE_BATCH_LIMIT);

    for _ in 0..limit {
        let step = {
            let connection = connection.lock().map_err(connection_lock_error)?;
            let queue = claim_next_due_scheduled_send(&connection, &now).map_err(storage_error)?;
            prepare_send_step(&connection, queue, now.clone())?
        };
        let idle = matches!(&step, PreparedSendStep::Idle);
        let result = finish_shared_step(connection, vault, adapter, step)?;
        if idle {
            break;
        }
        total.merge(result);
    }

    Ok(total)
}

fn process_claimed_send<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    queue: SendQueueRow,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let prepared = match prepare_claimed_send(connection, queue, now) {
        Ok(prepared) => prepared,
        Err(error) => {
            let (queue, now, error) = *error;
            return handle_send_failure(connection, &queue, &now, error);
        }
    };

    let outcome = deliver_prepared_send(vault, adapter, &prepared);
    persist_delivery_outcome(connection, &prepared, outcome)
}

fn prepare_send_step(
    connection: &Connection,
    queue: Option<SendQueueRow>,
    now: String,
) -> Result<PreparedSendStep, AppError> {
    let Some(queue) = queue else {
        return Ok(PreparedSendStep::Idle);
    };

    match prepare_claimed_send(connection, queue, now) {
        Ok(prepared) => Ok(PreparedSendStep::Ready(Box::new(prepared))),
        Err(error) => {
            let (queue, now, error) = *error;
            handle_send_failure(connection, &queue, &now, error).map(PreparedSendStep::Completed)
        }
    }
}

fn prepare_claimed_send(
    connection: &Connection,
    queue: SendQueueRow,
    now: String,
) -> Result<PreparedSend, Box<(SendQueueRow, String, AppError)>> {
    let prepared = (|| -> Result<(SmtpConnectionProfile, String, SmtpSendMessage), AppError> {
        let source = get_smtp_source_for_account(connection, &queue.account_id)
            .map_err(storage_error)?
            .ok_or_else(|| smtp_source_missing(&queue.account_id))?;
        let detail = get_message_detail(connection, &queue.message_id)
            .map_err(storage_error)?
            .ok_or_else(|| outgoing_message_missing(&queue.message_id))?;

        Ok((
            SmtpConnectionProfile {
                host: source.config.host,
                port: source.config.port,
                security: source.config.security,
                username: source.config.username,
            },
            source.secret_key,
            SmtpSendMessage {
                from_address: source.address,
                to_addresses: split_recipient_list(&queue.target_address),
                cc_addresses: queue.cc_addresses.clone(),
                bcc_addresses: queue.bcc_addresses.clone(),
                subject: detail.subject,
                body_text: detail.body_text.unwrap_or(detail.snippet),
            },
        ))
    })();

    match prepared {
        Ok((profile, secret_key, message)) => Ok(PreparedSend {
            queue,
            profile,
            secret_key,
            message,
            now,
        }),
        Err(error) => Err(Box::new((queue, now, error))),
    }
}

fn finish_shared_step<V, A>(
    connection: &Mutex<Connection>,
    vault: &V,
    adapter: &A,
    step: PreparedSendStep,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    match step {
        PreparedSendStep::Idle => Ok(SendQueueWorkerRunResult::default()),
        PreparedSendStep::Completed(result) => Ok(result),
        PreparedSendStep::Ready(prepared) => {
            let outcome = deliver_prepared_send(vault, adapter, &prepared);
            let connection = connection.lock().map_err(connection_lock_error)?;
            persist_delivery_outcome(&connection, &prepared, outcome)
        }
    }
}

fn deliver_prepared_send<V, A>(
    vault: &V,
    adapter: &A,
    prepared: &PreparedSend,
) -> Result<SmtpSendResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let secret = vault
        .load_secret(&prepared.secret_key)?
        .ok_or_else(|| smtp_secret_missing(&prepared.queue.account_id))?;
    adapter.send_message(&prepared.profile, &secret, &prepared.message)
}

fn persist_delivery_outcome(
    connection: &Connection,
    prepared: &PreparedSend,
    outcome: Result<SmtpSendResult, AppError>,
) -> Result<SendQueueWorkerRunResult, AppError> {
    match outcome {
        Ok(_) => {
            let changed = mark_send_sent(connection, &prepared.queue.id, &prepared.now)
                .map_err(storage_error)?;
            if !changed {
                let already_sent = get_send_queue_item(connection, &prepared.queue.id)
                    .map_err(storage_error)?
                    .is_some_and(|row| row.status == "sent");
                ensure_send_queue_transition(already_sent, &prepared.queue.id)?;
            }
            Ok(SendQueueWorkerRunResult {
                processed_count: 1,
                sent_count: 1,
                retry_count: 0,
                failed_count: 0,
            })
        }
        Err(error) => handle_send_failure(connection, &prepared.queue, &prepared.now, error),
    }
}

fn recover_stale_sends(
    connection: &Connection,
    now: &str,
) -> Result<SendQueueWorkerRunResult, AppError> {
    let stale_before = stale_send_before(now)?;
    let recovered =
        mark_stale_sends_delivery_unknown(connection, &stale_before, now).map_err(storage_error)?;
    Ok(SendQueueWorkerRunResult {
        processed_count: recovered,
        sent_count: 0,
        retry_count: 0,
        failed_count: recovered,
    })
}

fn handle_send_failure(
    connection: &Connection,
    queue: &SendQueueRow,
    now: &str,
    error: AppError,
) -> Result<SendQueueWorkerRunResult, AppError> {
    if error.category == ErrorCategory::Auth {
        ensure_send_queue_transition(
            mark_send_auth_failed(
                connection,
                &queue.id,
                &error.code,
                Some(&error.user_message),
                now,
            )
            .map_err(storage_error)?,
            &queue.id,
        )?;
        return Ok(SendQueueWorkerRunResult {
            processed_count: 1,
            sent_count: 0,
            retry_count: 0,
            failed_count: 1,
        });
    }

    if error.retryable {
        let next_retry_at = next_retry_at(now, queue.attempt_count)?;
        ensure_send_queue_transition(
            mark_send_retry(
                connection,
                &queue.id,
                &next_retry_at,
                &error.code,
                Some(&error.user_message),
                now,
            )
            .map_err(storage_error)?,
            &queue.id,
        )?;
        return Ok(SendQueueWorkerRunResult {
            processed_count: 1,
            sent_count: 0,
            retry_count: 1,
            failed_count: 0,
        });
    }

    ensure_send_queue_transition(
        mark_send_failed(
            connection,
            &queue.id,
            &error.code,
            Some(&error.user_message),
            now,
        )
        .map_err(storage_error)?,
        &queue.id,
    )?;
    Ok(SendQueueWorkerRunResult {
        processed_count: 1,
        sent_count: 0,
        retry_count: 0,
        failed_count: 1,
    })
}

fn split_recipient_list(value: &str) -> Vec<String> {
    value
        .split(|character: char| character == ',' || character == ';' || character.is_whitespace())
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .map(str::to_string)
        .collect()
}

fn stale_send_before(now: &str) -> Result<String, AppError> {
    let now = DateTime::parse_from_rfc3339(now).map_err(send_queue_time_error)?;
    Ok(now
        .with_timezone(&Utc)
        .checked_sub_signed(Duration::seconds(STALE_SENDING_LEASE_SECONDS))
        .ok_or_else(|| AppError::internal("send_queue_lease_overflow", "Send lease overflow."))?
        .to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn next_retry_at(now: &str, attempt_count: i64) -> Result<String, AppError> {
    let now = DateTime::parse_from_rfc3339(now).map_err(send_queue_time_error)?;
    let backoff = if attempt_count == 0 {
        Duration::seconds(60)
    } else {
        Duration::seconds(300)
    };
    Ok(now
        .with_timezone(&Utc)
        .checked_add_signed(backoff)
        .ok_or_else(|| AppError::internal("send_queue_backoff_overflow", "Backoff overflow."))?
        .to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn send_queue_time_error(error: chrono::ParseError) -> AppError {
    AppError {
        code: "send_queue_time_invalid".to_string(),
        category: ErrorCategory::Internal,
        user_message: "Send queue time could not be parsed.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

fn smtp_source_missing(account_id: &str) -> AppError {
    AppError {
        code: "smtp_source_missing".to_string(),
        category: ErrorCategory::Validation,
        user_message: "This account does not have an SMTP sending source.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}

fn smtp_secret_missing(account_id: &str) -> AppError {
    AppError {
        code: "smtp_secret_missing".to_string(),
        category: ErrorCategory::Storage,
        user_message: "The SMTP password reference exists but the secret could not be loaded."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::UnlockVault,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}

fn outgoing_message_missing(message_id: &str) -> AppError {
    AppError {
        code: "outgoing_message_missing".to_string(),
        category: ErrorCategory::Internal,
        user_message: "The queued outgoing message could not be loaded.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "message_id": message_id })),
    }
}

fn ensure_send_queue_transition(changed: bool, queue_id: &str) -> Result<(), AppError> {
    if changed {
        return Ok(());
    }

    Err(AppError {
        code: "send_queue_state_changed".to_string(),
        category: ErrorCategory::Internal,
        user_message:
            "The send queue item changed while the SMTP operation was running. Review its current status before retrying."
                .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "queue_id": queue_id })),
    })
}

fn storage_error(error: rusqlite::Error) -> AppError {
    AppError {
        code: "sqlite_send_queue_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Send queue state could not be updated.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

fn connection_lock_error(
    error: std::sync::PoisonError<std::sync::MutexGuard<'_, Connection>>,
) -> AppError {
    AppError {
        code: "sqlite_connection_lock_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "The local database is temporarily unavailable.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use rusqlite::Connection;

    use crate::secret::fake::FakeSecretVaultAdapter;
    use crate::secret::SecretVaultAdapter;
    use crate::smtp::fake::FakeSmtpAdapter;
    use crate::smtp::models::SmtpConnectionTestResult;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;
    use crate::storage::send_queue_repository::list_recent_send_queue;

    use super::*;

    struct BlockingSmtpAdapter {
        entered: SyncSender<()>,
        release: Mutex<Receiver<()>>,
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
            self.entered.send(()).map_err(|error| {
                AppError::internal("blocking_smtp_enter_failed", error.to_string())
            })?;
            self.release
                .lock()
                .map_err(|error| {
                    AppError::internal("blocking_smtp_lock_failed", error.to_string())
                })?
                .recv()
                .map_err(|error| {
                    AppError::internal("blocking_smtp_release_failed", error.to_string())
                })?;
            Ok(SmtpSendResult {
                provider_message_id: Some("provider-message-1".to_string()),
            })
        }
    }

    #[test]
    fn smtp_retryable_error_requeues_with_backoff() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        seed_queued_send(&connection);
        let adapter = FakeSmtpAdapter::retryable_failure();

        let result = run_send_queue_once(
            &connection,
            &vault,
            &adapter,
            "2026-06-12T01:20:00Z".to_string(),
        )
        .expect("worker");

        assert_eq!(result.processed_count, 1);
        let rows = list_recent_send_queue(&connection, 10).expect("list queue");
        assert_eq!(rows[0].status, "queued");
        assert_eq!(rows[0].attempt_count, 1);
        assert_eq!(
            rows[0].next_retry_at,
            Some("2026-06-12T01:21:00Z".to_string())
        );
    }

    #[test]
    fn smtp_auth_failure_sets_action_required() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        seed_queued_send(&connection);
        let adapter = FakeSmtpAdapter::auth_failure();

        run_send_queue_once(
            &connection,
            &vault,
            &adapter,
            "2026-06-12T01:20:00Z".to_string(),
        )
        .expect("worker");

        let rows = list_recent_send_queue(&connection, 10).expect("list queue");
        assert_eq!(rows[0].status, "auth_failed");
        assert_eq!(
            rows[0].last_error_code,
            Some("smtp_auth_failed".to_string())
        );
    }

    #[test]
    fn missing_smtp_secret_marks_claimed_send_failed() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        vault
            .delete_secret("secret://smtp/acct_send")
            .expect("delete smtp secret");
        seed_queued_send(&connection);
        let adapter = FakeSmtpAdapter::success();

        let result = run_send_queue_once(
            &connection,
            &vault,
            &adapter,
            "2026-06-12T01:20:00Z".to_string(),
        )
        .expect("worker handles missing secret");

        let rows = list_recent_send_queue(&connection, 10).expect("list queue");
        assert_eq!(result.failed_count, 1);
        assert_eq!(rows[0].status, "failed");
        assert_eq!(
            rows[0].last_error_code.as_deref(),
            Some("smtp_secret_missing")
        );
        assert!(adapter.sent_messages().is_empty());
    }

    #[test]
    fn missing_smtp_source_marks_claimed_send_failed() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        seed_queued_send(&connection);
        connection
            .execute(
                "UPDATE mailbox_sources SET source_kind = 'imap' WHERE id = 'src_smtp'",
                [],
            )
            .expect("remove smtp source role");
        let adapter = FakeSmtpAdapter::success();

        let result = run_send_queue_once(
            &connection,
            &vault,
            &adapter,
            "2026-06-12T01:20:00Z".to_string(),
        )
        .expect("worker handles missing source");

        let rows = list_recent_send_queue(&connection, 10).expect("list queue");
        assert_eq!(result.failed_count, 1);
        assert_eq!(rows[0].status, "failed");
        assert_eq!(
            rows[0].last_error_code.as_deref(),
            Some("smtp_source_missing")
        );
        assert!(adapter.sent_messages().is_empty());
    }

    #[test]
    fn send_queue_worker_is_idempotent() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        seed_queued_send(&connection);
        let adapter = FakeSmtpAdapter::success();

        let first = run_send_queue_once(
            &connection,
            &vault,
            &adapter,
            "2026-06-12T01:20:00Z".to_string(),
        )
        .expect("first worker");
        let second = run_send_queue_once(
            &connection,
            &vault,
            &adapter,
            "2026-06-12T01:20:01Z".to_string(),
        )
        .expect("second worker");

        assert_eq!(first.processed_count, 1);
        assert_eq!(second.processed_count, 0);
        assert_eq!(adapter.sent_messages().len(), 1);
    }

    #[test]
    fn stale_sending_job_is_not_automatically_retried_after_restart() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        seed_queued_send(&connection);
        claim_due_send_by_id(&connection, "send_outgoing", "2026-06-12T01:10:00Z")
            .expect("claim send")
            .expect("claimed send");
        let adapter = FakeSmtpAdapter::success();

        let result = run_send_queue_once(
            &connection,
            &vault,
            &adapter,
            "2026-06-12T01:26:00Z".to_string(),
        )
        .expect("recover stale send");

        let row = list_recent_send_queue(&connection, 10)
            .expect("list queue")
            .remove(0);
        assert_eq!(result.processed_count, 1);
        assert_eq!(result.failed_count, 1);
        assert_eq!(row.status, "failed");
        assert_eq!(row.next_retry_at, None);
        assert_eq!(
            row.last_error_code.as_deref(),
            Some("smtp_delivery_unknown")
        );
        assert!(adapter.sent_messages().is_empty());
    }

    #[test]
    fn shared_worker_releases_database_lock_during_smtp_round_trip() {
        let connection = Arc::new(Mutex::new(test_connection()));
        let vault = FakeSecretVaultAdapter::default();
        {
            let connection = connection.lock().expect("seed lock");
            seed_send_enabled_normal_account_with_secret(&connection, &vault);
            seed_queued_send(&connection);
        }
        let (entered_tx, entered_rx) = sync_channel(1);
        let (release_tx, release_rx) = sync_channel(1);
        let adapter = BlockingSmtpAdapter {
            entered: entered_tx,
            release: Mutex::new(release_rx),
        };
        let worker_connection = Arc::clone(&connection);
        let worker_vault = vault.clone();

        let handle = thread::spawn(move || {
            run_send_queue_once_shared(
                &worker_connection,
                &worker_vault,
                &adapter,
                "2026-06-12T01:20:00Z".to_string(),
            )
        });

        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("SMTP operation started");
        {
            let connection = connection
                .try_lock()
                .expect("database lock must be available during SMTP");
            let status: String = connection
                .query_row(
                    "SELECT status FROM send_queue WHERE id = 'send_outgoing'",
                    [],
                    |row| row.get(0),
                )
                .expect("read queue while SMTP is blocked");
            assert_eq!(status, "sending");
        }
        release_tx.send(()).expect("release SMTP operation");

        let result = handle.join().expect("join worker").expect("worker result");
        assert_eq!(result.sent_count, 1);
        assert_eq!(
            list_recent_send_queue(&connection.lock().expect("final lock"), 10,)
                .expect("list final queue")[0]
                .status,
            "sent"
        );
    }

    #[test]
    fn send_queue_worker_can_run_requested_item_without_processing_older_queue() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        seed_queued_send_with(
            &connection,
            "msg_old",
            "send-old",
            "old@example.test",
            "2026-06-12T01:10:00Z",
        );
        seed_queued_send_with(
            &connection,
            "msg_new",
            "send-new",
            "new@example.test",
            "2026-06-12T01:11:00Z",
        );
        let adapter = FakeSmtpAdapter::success();

        let result = run_send_queue_item(
            &connection,
            &vault,
            &adapter,
            "send-new",
            "2026-06-12T01:20:00Z".to_string(),
        )
        .expect("targeted worker");

        let rows = list_recent_send_queue(&connection, 10).expect("list queue");
        let old_row = rows
            .iter()
            .find(|row| row.id == "send-old")
            .expect("old row");
        let new_row = rows
            .iter()
            .find(|row| row.id == "send-new")
            .expect("new row");

        assert_eq!(result.sent_count, 1);
        assert_eq!(new_row.status, "sent");
        assert_eq!(old_row.status, "queued");
        assert_eq!(
            adapter.sent_messages()[0].to_addresses,
            vec!["new@example.test"]
        );
    }

    #[test]
    fn send_queue_due_batch_processes_all_due_items_and_skips_future_scheduled_items() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        seed_queued_send_with(
            &connection,
            "msg_unscheduled",
            "send-unscheduled",
            "unscheduled@example.test",
            "2026-06-12T01:09:00Z",
        );
        seed_queued_send_with_due(
            &connection,
            "msg_due_one",
            "send-due-one",
            "one@example.test",
            Some("2026-06-12T01:19:00Z"),
            "2026-06-12T01:10:00Z",
        );
        seed_queued_send_with_due(
            &connection,
            "msg_due_two",
            "send-due-two",
            "two@example.test",
            Some("2026-06-12T01:20:00Z"),
            "2026-06-12T01:11:00Z",
        );
        seed_queued_send_with_due(
            &connection,
            "msg_future",
            "send-future",
            "future@example.test",
            Some("2026-06-12T01:21:00Z"),
            "2026-06-12T01:12:00Z",
        );
        let adapter = FakeSmtpAdapter::success();

        let result = run_send_queue_due_batch(
            &connection,
            &vault,
            &adapter,
            "2026-06-12T01:20:00Z".to_string(),
            10,
        )
        .expect("due batch");

        let rows = list_recent_send_queue(&connection, 10).expect("list queue");
        let future = rows
            .iter()
            .find(|row| row.id == "send-future")
            .expect("future row");
        let unscheduled = rows
            .iter()
            .find(|row| row.id == "send-unscheduled")
            .expect("unscheduled row");

        assert_eq!(result.processed_count, 2);
        assert_eq!(result.sent_count, 2);
        assert_eq!(adapter.sent_messages().len(), 2);
        assert_eq!(future.status, "queued");
        assert_eq!(unscheduled.status, "queued");
    }

    #[test]
    fn send_queue_due_batch_caps_extreme_limits() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        let now = "2026-06-12T01:20:00Z";

        for index in 0..=MAX_SEND_QUEUE_BATCH_LIMIT {
            seed_queued_send_with_due(
                &connection,
                &format!("msg_due_{index}"),
                &format!("send-due-{index}"),
                &format!("target-{index}@example.test"),
                Some("2026-06-12T01:19:00Z"),
                now,
            );
        }
        let adapter = FakeSmtpAdapter::success();

        let result =
            run_send_queue_due_batch(&connection, &vault, &adapter, now.to_string(), usize::MAX)
                .expect("bounded due batch");
        let queued_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM send_queue WHERE status = 'queued'",
                [],
                |row| row.get(0),
            )
            .expect("count remaining queue");

        assert_eq!(result.processed_count, MAX_SEND_QUEUE_BATCH_LIMIT);
        assert_eq!(adapter.sent_messages().len(), MAX_SEND_QUEUE_BATCH_LIMIT);
        assert_eq!(queued_count, 1);
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    fn seed_send_enabled_normal_account_with_secret(
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

    fn seed_queued_send(connection: &Connection) {
        seed_queued_send_with(
            connection,
            "msg_outgoing",
            "send_outgoing",
            "target@example.test",
            "2026-06-12T01:10:00Z",
        );
    }

    fn seed_queued_send_with(
        connection: &Connection,
        message_id: &str,
        queue_id: &str,
        target_address: &str,
        now: &str,
    ) {
        seed_queued_send_with_due(connection, message_id, queue_id, target_address, None, now);
    }

    fn seed_queued_send_with_due(
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
}
