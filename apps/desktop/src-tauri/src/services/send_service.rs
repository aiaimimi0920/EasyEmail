use chrono::DateTime;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::storage::account_repository::{get_account, get_smtp_source_for_account, AccountRow};
use crate::storage::message_repository::{
    insert_outgoing_message, NewOutgoingMessage, OutgoingMessageRow,
};
use crate::storage::send_queue_repository::{enqueue_send, NewSendQueueItem, SendQueueRow};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendMessageRequest {
    pub account_id: String,
    pub target_address: String,
    pub cc_addresses: Vec<String>,
    pub bcc_addresses: Vec<String>,
    pub scheduled_at: Option<String>,
    pub subject: String,
    pub body_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendMessageResult {
    pub message: OutgoingMessageRow,
    pub queue: SendQueueRow,
}

pub fn enqueue_send_message(
    connection: &Connection,
    request: SendMessageRequest,
    now: String,
) -> Result<SendMessageResult, AppError> {
    let request = normalize_send_request(request)?;
    let account = get_account(connection, &request.account_id)
        .map_err(storage_error)?
        .ok_or_else(|| send_account_not_found(&request.account_id))?;
    validate_account_can_send(&account)?;
    let source = get_smtp_source_for_account(connection, &request.account_id)
        .map_err(storage_error)?
        .ok_or_else(|| smtp_source_missing(&request.account_id))?;
    let from_address = source
        .account
        .primary_address
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&source.address);
    let transaction = connection.unchecked_transaction().map_err(storage_error)?;
    let message = insert_outgoing_message(
        &transaction,
        NewOutgoingMessage {
            account_id: account.id.clone(),
            source_id: source.source_id.clone(),
            from_address: from_address.to_string(),
            target_address: request.target_address.clone(),
            subject: request.subject,
            body_text: request.body_text,
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let queue = enqueue_send(
        &transaction,
        NewSendQueueItem {
            account_id: account.id,
            source_id: source.source_id,
            message_id: message.id.clone(),
            target_address: request.target_address,
            cc_addresses: request.cc_addresses,
            bcc_addresses: request.bcc_addresses,
            scheduled_at: request.scheduled_at,
            now,
        },
    )
    .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)?;

    Ok(SendMessageResult { message, queue })
}

fn normalize_send_request(request: SendMessageRequest) -> Result<SendMessageRequest, AppError> {
    let target_addresses = normalize_address_list(vec![request.target_address]);
    let normalized = SendMessageRequest {
        account_id: request.account_id.trim().to_string(),
        target_address: target_addresses.join(", "),
        cc_addresses: normalize_address_list(request.cc_addresses),
        bcc_addresses: normalize_address_list(request.bcc_addresses),
        scheduled_at: normalize_scheduled_at(request.scheduled_at)?,
        subject: request.subject.trim().to_string(),
        body_text: request.body_text,
    };

    if normalized.account_id.is_empty()
        || normalized.target_address.is_empty()
        || normalized.subject.is_empty()
    {
        return Err(AppError {
            code: "send_message_invalid".to_string(),
            category: ErrorCategory::Validation,
            user_message: "Select a sender account and enter a target address and subject."
                .to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::EditSettings,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }

    Ok(normalized)
}

fn normalize_scheduled_at(value: Option<String>) -> Result<Option<String>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    DateTime::parse_from_rfc3339(trimmed).map_err(|_| AppError {
        code: "send_schedule_invalid".to_string(),
        category: ErrorCategory::Validation,
        user_message: "Choose a valid scheduled send time.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    })?;
    Ok(Some(trimmed.to_string()))
}

fn normalize_address_list(addresses: Vec<String>) -> Vec<String> {
    addresses
        .into_iter()
        .flat_map(|address| {
            address
                .split(|character: char| {
                    character == ',' || character == ';' || character.is_whitespace()
                })
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .map(|address| address.trim().to_ascii_lowercase())
        .filter(|address| !address.is_empty())
        .collect()
}

fn validate_account_can_send(account: &AccountRow) -> Result<(), AppError> {
    if account.kind == "anonymous_virtual" {
        return Err(AppError {
            code: "anonymous_account_cannot_send".to_string(),
            category: ErrorCategory::Validation,
            user_message: "Anonymous virtual mailboxes cannot send mail.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "account_id": account.id })),
        });
    }

    if account.send_status != "enabled" {
        return Err(AppError {
            code: "send_not_enabled".to_string(),
            category: ErrorCategory::Validation,
            user_message: "This account is not enabled for sending.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::EditSettings,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({
                "account_id": account.id,
                "send_status": account.send_status,
            })),
        });
    }

    Ok(())
}

fn send_account_not_found(account_id: &str) -> AppError {
    AppError {
        code: "send_account_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected sender account no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
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

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::storage::account_repository::ensure_anonymous_virtual_account;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    use super::*;

    #[test]
    fn send_message_requires_send_enabled() {
        let connection = test_connection();
        seed_receive_only_normal_account(&connection);

        let error = enqueue_send_message(
            &connection,
            SendMessageRequest {
                account_id: "acct_receive_only".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                subject: "Hello".to_string(),
                body_text: "Queued body".to_string(),
            },
            "2026-06-12T01:10:00Z".to_string(),
        )
        .expect_err("send disabled");

        assert_eq!(error.code, "send_not_enabled");
    }

    #[test]
    fn anonymous_account_cannot_send() {
        let connection = test_connection();
        ensure_anonymous_virtual_account(&connection, "2026-06-12T01:10:00Z".to_string())
            .expect("anonymous");

        let error = enqueue_send_message(
            &connection,
            SendMessageRequest {
                account_id: "acct_anonymous_virtual".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                subject: "Hello".to_string(),
                body_text: "Queued body".to_string(),
            },
            "2026-06-12T01:10:00Z".to_string(),
        )
        .expect_err("anonymous blocked");

        assert_eq!(error.code, "anonymous_account_cannot_send");
    }

    #[test]
    fn send_message_enqueues_without_calling_smtp() {
        let connection = test_connection();
        seed_send_enabled_normal_account(&connection);

        let result = enqueue_send_message(
            &connection,
            SendMessageRequest {
                account_id: "acct_send".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: vec![" CC@Example.TEST ".to_string(), "".to_string()],
                bcc_addresses: vec![" BCC@Example.TEST ".to_string()],
                scheduled_at: None,
                subject: "Hello".to_string(),
                body_text: "Queued body".to_string(),
            },
            "2026-06-12T01:10:00Z".to_string(),
        )
        .expect("enqueue");

        assert_eq!(result.queue.status, "queued");
        assert_eq!(result.message.subject, "Hello");
        assert_eq!(result.queue.cc_addresses, vec!["cc@example.test"]);
        assert_eq!(result.queue.bcc_addresses, vec!["bcc@example.test"]);
    }

    #[test]
    fn send_message_rolls_back_message_when_queue_insert_fails() {
        let connection = test_connection();
        seed_send_enabled_normal_account(&connection);
        connection
            .execute_batch(
                "CREATE TRIGGER fail_send_queue_insert
                 BEFORE INSERT ON send_queue
                 BEGIN
                   SELECT RAISE(ABORT, 'forced send queue failure');
                 END;",
            )
            .expect("install failure trigger");

        let error = enqueue_send_message(
            &connection,
            SendMessageRequest {
                account_id: "acct_send".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                subject: "Must roll back".to_string(),
                body_text: "Queued body".to_string(),
            },
            "2026-06-12T01:10:00Z".to_string(),
        )
        .expect_err("queue insert should fail");
        let message_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE subject = 'Must roll back'",
                [],
                |row| row.get(0),
            )
            .expect("count rolled back messages");
        let queue_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM send_queue", [], |row| row.get(0))
            .expect("count queue");

        assert_eq!(error.code, "sqlite_send_queue_failed");
        assert_eq!(message_count, 0);
        assert_eq!(queue_count, 0);
    }

    #[test]
    fn send_message_normalizes_multiple_to_recipients() {
        let connection = test_connection();
        seed_send_enabled_normal_account(&connection);

        let result = enqueue_send_message(
            &connection,
            SendMessageRequest {
                account_id: "acct_send".to_string(),
                target_address: " First@Example.TEST, Second@Example.TEST third@example.test "
                    .to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                subject: "Hello".to_string(),
                body_text: "Queued body".to_string(),
            },
            "2026-06-12T01:00:00Z".to_string(),
        )
        .expect("send result");

        assert_eq!(
            result.queue.target_address,
            "first@example.test, second@example.test, third@example.test"
        );
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    fn seed_receive_only_normal_account(connection: &Connection) {
        seed_account(connection, "acct_receive_only", "unsupported", false);
    }

    fn seed_send_enabled_normal_account(connection: &Connection) {
        seed_account(connection, "acct_send", "enabled", true);
    }

    fn seed_account(
        connection: &Connection,
        account_id: &str,
        send_status: &str,
        include_smtp_source: bool,
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
                ) VALUES (?1, 'normal', 'normal_long_lived', 'Sender', 'sender@example.test', 'Manual SMTP', 'ready', 'valid', 'enabled', ?2, 1, '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
                rusqlite::params![account_id, send_status],
            )
            .expect("insert account");

        if include_smtp_source {
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
                    ) VALUES ('src_smtp', ?1, 'smtp', 'sender@example.test', 'smtp.example.test', '{\"host\":\"smtp.example.test\",\"port\":587,\"security\":\"starttls\",\"username\":\"sender@example.test\"}', 'cred_smtp', 'ready', '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
                    rusqlite::params![account_id],
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
                    ) VALUES ('cred_smtp', ?1, 'src_smtp', 'fake_vault', 'secret://smtp/acct_send', 'smtp_password', 'password', 'active', '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
                    rusqlite::params![account_id],
                )
                .expect("insert credential");
        }
    }
}
