use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::Connection;

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::storage::send_queue_repository::{
    mark_send_auth_failed, mark_send_failed, mark_send_retry, mark_stale_sends_delivery_unknown,
    SendQueueRow,
};

use super::SendQueueWorkerRunResult;

const STALE_SENDING_LEASE_SECONDS: i64 = 15 * 60;

pub(super) fn recover_stale_sends(
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

pub(super) fn handle_send_failure(
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

pub(super) fn smtp_source_missing(account_id: &str) -> AppError {
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

pub(super) fn smtp_secret_missing(account_id: &str) -> AppError {
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

pub(super) fn outgoing_message_missing(message_id: &str) -> AppError {
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

pub(super) fn ensure_send_queue_transition(changed: bool, queue_id: &str) -> Result<(), AppError> {
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

pub(super) fn storage_error(error: rusqlite::Error) -> AppError {
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

pub(super) fn connection_lock_error(
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
