use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::storage::account_repository::{get_account, get_smtp_source_for_account};
use crate::storage::agent_repository::{
    create_agent_thread, find_agent_thread_by_outgoing_rfc_message_id, get_agent_service,
    get_agent_service_by_email, get_agent_thread, insert_agent_message,
    update_agent_thread_after_incoming, update_agent_thread_after_outgoing, AgentMessageRow,
    AgentThreadRow, NewAgentMessage, NewAgentThread,
};
use crate::storage::message_repository::{
    get_message_for_agent_association, insert_outgoing_message, NewOutgoingMessage,
};
use crate::storage::send_queue_repository::{enqueue_send, NewSendQueueItem, SendQueueRow};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSendTaskRequest {
    pub agent_service_id: String,
    pub sender_account_id: String,
    pub subject: String,
    pub body_text: String,
    pub confirm_restricted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSendTaskResult {
    pub thread: AgentThreadRow,
    pub queue: SendQueueRow,
    pub agent_message: AgentMessageRow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReplyAssociationRequest {
    pub message_id: String,
    pub from_address: String,
    pub in_reply_to_message_id: Option<String>,
    pub references: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentReplyAssociationResult {
    pub status: String,
    pub thread: AgentThreadRow,
    pub agent_message: AgentMessageRow,
}

pub fn agent_send_task(
    connection: &Connection,
    request: AgentSendTaskRequest,
    now: String,
) -> Result<AgentSendTaskResult, AppError> {
    let request = normalize_agent_send_task_request(request)?;
    let sender = get_account(connection, &request.sender_account_id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_sender_not_found(&request.sender_account_id))?;
    if sender.scope != "agent" {
        return Err(agent_sender_scope_required(&sender.id));
    }
    if sender.send_status != "enabled" {
        return Err(agent_sender_send_not_enabled(
            &sender.id,
            &sender.send_status,
        ));
    }

    let service = get_agent_service(connection, &request.agent_service_id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_service_not_found(&request.agent_service_id))?;
    validate_agent_service_trust(&service.trust_level, request.confirm_restricted)?;

    let source = get_smtp_source_for_account(connection, &sender.id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_sender_smtp_missing(&sender.id))?;
    let from_address = source
        .account
        .primary_address
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| source.address.clone());
    let transaction = connection.unchecked_transaction().map_err(storage_error)?;
    let message = insert_outgoing_message(
        &transaction,
        NewOutgoingMessage {
            account_id: sender.id.clone(),
            source_id: source.source_id.clone(),
            from_address,
            target_address: service.email_address.clone(),
            subject: request.subject.clone(),
            body_text: request.body_text,
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let thread = create_agent_thread(
        &transaction,
        NewAgentThread {
            agent_service_id: service.id,
            sender_account_id: sender.id.clone(),
            subject: request.subject,
            correlation_key: format!("agent-{}", Uuid::new_v4()),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let agent_message = insert_agent_message(
        &transaction,
        NewAgentMessage {
            thread_id: thread.id.clone(),
            message_id: message.id.clone(),
            direction: "outgoing".to_string(),
            semantic_role: "task_request".to_string(),
            parsed_status: Some("queued".to_string()),
            parsed_payload_json: "{}".to_string(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    update_agent_thread_after_outgoing(
        &transaction,
        &thread.id,
        &message.id,
        "awaiting_reply",
        &now,
    )
    .map_err(storage_error)?;
    let queue = enqueue_send(
        &transaction,
        NewSendQueueItem {
            account_id: sender.id,
            source_id: source.source_id,
            message_id: message.id,
            target_address: service.email_address,
            cc_addresses: Vec::new(),
            bcc_addresses: Vec::new(),
            scheduled_at: None,
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let thread = get_agent_thread(&transaction, &thread.id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_thread_missing_after_send(&thread.id))?;
    transaction.commit().map_err(storage_error)?;

    Ok(AgentSendTaskResult {
        thread,
        queue,
        agent_message,
    })
}

pub fn associate_incoming_agent_reply(
    connection: &Connection,
    request: AgentReplyAssociationRequest,
    now: String,
) -> Result<AgentReplyAssociationResult, AppError> {
    let request = normalize_agent_reply_association_request(request)?;
    let message = get_message_for_agent_association(connection, &request.message_id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_reply_message_not_found(&request.message_id))?;
    let service = get_agent_service_by_email(connection, &request.from_address)
        .map_err(storage_error)?
        .ok_or_else(|| agent_service_unknown(&request.from_address))?;

    if let Some(thread) = find_thread_by_reply_headers(connection, &service.id, &request)? {
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        let agent_message = insert_agent_message(
            &transaction,
            NewAgentMessage {
                thread_id: thread.id.clone(),
                message_id: message.message_id,
                direction: "incoming".to_string(),
                semantic_role: "agent_reply".to_string(),
                parsed_status: Some("linked".to_string()),
                parsed_payload_json: "{}".to_string(),
                now: now.clone(),
            },
        )
        .map_err(storage_error)?;
        update_agent_thread_after_incoming(
            &transaction,
            &thread.id,
            &agent_message.message_id,
            "in_progress",
            &now,
        )
        .map_err(storage_error)?;
        let thread = get_agent_thread(&transaction, &thread.id)
            .map_err(storage_error)?
            .ok_or_else(|| agent_thread_missing_after_reply(&thread.id))?;
        transaction.commit().map_err(storage_error)?;

        return Ok(AgentReplyAssociationResult {
            status: "linked".to_string(),
            thread,
            agent_message,
        });
    }

    let sender_account_id = service
        .default_sender_account_id
        .clone()
        .ok_or_else(|| agent_service_default_sender_missing(&service.id))?;
    let transaction = connection.unchecked_transaction().map_err(storage_error)?;
    let thread = create_agent_thread(
        &transaction,
        NewAgentThread {
            agent_service_id: service.id,
            sender_account_id,
            subject: message.subject,
            correlation_key: format!("agent-unmatched-{}", Uuid::new_v4()),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let agent_message = insert_agent_message(
        &transaction,
        NewAgentMessage {
            thread_id: thread.id.clone(),
            message_id: message.message_id,
            direction: "incoming".to_string(),
            semantic_role: "agent_reply".to_string(),
            parsed_status: Some("needs_attention".to_string()),
            parsed_payload_json: "{}".to_string(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    update_agent_thread_after_incoming(
        &transaction,
        &thread.id,
        &agent_message.message_id,
        "needs_attention",
        &now,
    )
    .map_err(storage_error)?;
    let thread = get_agent_thread(&transaction, &thread.id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_thread_missing_after_reply(&thread.id))?;
    transaction.commit().map_err(storage_error)?;

    Ok(AgentReplyAssociationResult {
        status: "needs_attention".to_string(),
        thread,
        agent_message,
    })
}

fn normalize_agent_send_task_request(
    request: AgentSendTaskRequest,
) -> Result<AgentSendTaskRequest, AppError> {
    let normalized = AgentSendTaskRequest {
        agent_service_id: request.agent_service_id.trim().to_string(),
        sender_account_id: request.sender_account_id.trim().to_string(),
        subject: request.subject.trim().to_string(),
        body_text: request.body_text,
        confirm_restricted: request.confirm_restricted,
    };
    if normalized.agent_service_id.is_empty()
        || normalized.sender_account_id.is_empty()
        || normalized.subject.is_empty()
    {
        return Err(AppError {
            code: "agent_task_invalid".to_string(),
            category: ErrorCategory::Validation,
            user_message: "Select an Agent service, Agent sender account, and subject.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::EditSettings,
            correlation_id: Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }
    Ok(normalized)
}

fn normalize_agent_reply_association_request(
    request: AgentReplyAssociationRequest,
) -> Result<AgentReplyAssociationRequest, AppError> {
    let normalized = AgentReplyAssociationRequest {
        message_id: request.message_id.trim().to_string(),
        from_address: request.from_address.trim().to_ascii_lowercase(),
        in_reply_to_message_id: request
            .in_reply_to_message_id
            .and_then(|value| normalize_header_message_id(&value)),
        references: request
            .references
            .into_iter()
            .flat_map(|value| {
                value
                    .split_whitespace()
                    .filter_map(normalize_header_message_id)
                    .collect::<Vec<_>>()
            })
            .collect(),
    };
    if normalized.message_id.is_empty() || normalized.from_address.is_empty() {
        return Err(AppError {
            code: "agent_reply_association_invalid".to_string(),
            category: ErrorCategory::Validation,
            user_message: "Agent replies need a message id and sender address.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }
    Ok(normalized)
}

fn find_thread_by_reply_headers(
    connection: &Connection,
    agent_service_id: &str,
    request: &AgentReplyAssociationRequest,
) -> Result<Option<AgentThreadRow>, AppError> {
    let mut candidates = Vec::new();
    if let Some(in_reply_to) = request.in_reply_to_message_id.as_ref() {
        candidates.push(in_reply_to.clone());
    }
    candidates.extend(request.references.iter().cloned());

    for candidate in dedupe_non_empty(candidates) {
        let thread =
            find_agent_thread_by_outgoing_rfc_message_id(connection, agent_service_id, &candidate)
                .map_err(storage_error)?;
        if thread.is_some() {
            return Ok(thread);
        }
    }
    Ok(None)
}

fn normalize_header_message_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn dedupe_non_empty(values: Vec<String>) -> Vec<String> {
    let mut deduped = Vec::new();
    for value in values {
        let Some(value) = normalize_header_message_id(&value) else {
            continue;
        };
        if !deduped.iter().any(|existing| existing == &value) {
            deduped.push(value);
        }
    }
    deduped
}

fn validate_agent_service_trust(
    trust_level: &str,
    confirm_restricted: bool,
) -> Result<(), AppError> {
    match trust_level {
        "blocked" => Err(AppError {
            code: "agent_service_blocked".to_string(),
            category: ErrorCategory::Validation,
            user_message: "This remote Agent service is blocked.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "trust_level": trust_level })),
        }),
        "restricted" if !confirm_restricted => Err(AppError {
            code: "agent_service_restricted_confirmation_required".to_string(),
            category: ErrorCategory::Validation,
            user_message: "Confirm before sending a task to a restricted Agent service."
                .to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::Confirm,
            correlation_id: Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "trust_level": trust_level })),
        }),
        _ => Ok(()),
    }
}

fn agent_sender_scope_required(account_id: &str) -> AppError {
    AppError {
        code: "agent_sender_scope_required".to_string(),
        category: ErrorCategory::Validation,
        user_message: "Agent task mail must be sent from an Agent-scoped account.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}

fn agent_sender_send_not_enabled(account_id: &str, send_status: &str) -> AppError {
    AppError {
        code: "agent_sender_send_not_enabled".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The Agent sender account is not enabled for SMTP sending.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({
            "account_id": account_id,
            "send_status": send_status,
        })),
    }
}

fn agent_sender_not_found(account_id: &str) -> AppError {
    AppError {
        code: "agent_sender_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected Agent sender account no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}

fn agent_sender_smtp_missing(account_id: &str) -> AppError {
    AppError {
        code: "agent_sender_smtp_missing".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The Agent sender account does not have an SMTP source.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}

fn agent_service_not_found(agent_service_id: &str) -> AppError {
    AppError {
        code: "agent_service_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected remote Agent service no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "agent_service_id": agent_service_id })),
    }
}

fn agent_thread_missing_after_send(thread_id: &str) -> AppError {
    AppError {
        code: "agent_thread_missing_after_send".to_string(),
        category: ErrorCategory::Internal,
        user_message: "The Agent thread could not be loaded after enqueueing the task.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "thread_id": thread_id })),
    }
}

fn agent_reply_message_not_found(message_id: &str) -> AppError {
    AppError {
        code: "agent_reply_message_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The incoming Agent reply message no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "message_id": message_id })),
    }
}

fn agent_service_unknown(from_address: &str) -> AppError {
    AppError {
        code: "agent_service_unknown".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The sender is not a known remote Agent service.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "from_address": from_address })),
    }
}

fn agent_service_default_sender_missing(agent_service_id: &str) -> AppError {
    AppError {
        code: "agent_service_default_sender_missing".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The remote Agent service does not have a default Agent sender account."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "agent_service_id": agent_service_id })),
    }
}

fn agent_thread_missing_after_reply(thread_id: &str) -> AppError {
    AppError {
        code: "agent_thread_missing_after_reply".to_string(),
        category: ErrorCategory::Internal,
        user_message: "The Agent thread could not be loaded after associating the reply."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "thread_id": thread_id })),
    }
}

fn storage_error(error: rusqlite::Error) -> AppError {
    AppError {
        code: "sqlite_agent_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Agent mailbox state could not be updated.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    use super::*;

    #[test]
    fn agent_task_requires_agent_scope_sender() {
        let connection = test_connection();
        seed_normal_sender_and_agent_service(&connection, "trusted");

        let error = agent_send_task(
            &connection,
            AgentSendTaskRequest {
                agent_service_id: "agsvc_1".to_string(),
                sender_account_id: "acct_normal".to_string(),
                subject: "Research task".to_string(),
                body_text: "Please summarize this.".to_string(),
                confirm_restricted: false,
            },
            "2026-06-12T02:20:00Z".to_string(),
        )
        .expect_err("normal sender blocked");

        assert_eq!(error.code, "agent_sender_scope_required");
    }

    #[test]
    fn blocked_agent_service_rejects_send() {
        let connection = test_connection();
        seed_agent_sender_and_service(&connection, "blocked");

        let error = agent_send_task(
            &connection,
            AgentSendTaskRequest {
                agent_service_id: "agsvc_1".to_string(),
                sender_account_id: "acct_agent".to_string(),
                subject: "Research task".to_string(),
                body_text: "Please summarize this.".to_string(),
                confirm_restricted: false,
            },
            "2026-06-12T02:20:00Z".to_string(),
        )
        .expect_err("blocked service rejected");

        assert_eq!(error.code, "agent_service_blocked");
    }

    #[test]
    fn restricted_agent_service_requires_confirmation() {
        let connection = test_connection();
        seed_agent_sender_and_service(&connection, "restricted");

        let error = agent_send_task(
            &connection,
            AgentSendTaskRequest {
                agent_service_id: "agsvc_1".to_string(),
                sender_account_id: "acct_agent".to_string(),
                subject: "Research task".to_string(),
                body_text: "Please summarize this.".to_string(),
                confirm_restricted: false,
            },
            "2026-06-12T02:20:00Z".to_string(),
        )
        .expect_err("confirmation required");

        assert_eq!(error.code, "agent_service_restricted_confirmation_required");
    }

    #[test]
    fn trusted_agent_task_send_creates_thread_message_and_queue() {
        let connection = test_connection();
        seed_agent_sender_and_service(&connection, "trusted");

        let result = agent_send_task(
            &connection,
            AgentSendTaskRequest {
                agent_service_id: "agsvc_1".to_string(),
                sender_account_id: "acct_agent".to_string(),
                subject: "Research task".to_string(),
                body_text: "Please summarize this.".to_string(),
                confirm_restricted: false,
            },
            "2026-06-12T02:20:00Z".to_string(),
        )
        .expect("send task");

        assert_eq!(result.thread.status, "awaiting_reply");
        assert_eq!(result.queue.status, "queued");
        assert_eq!(result.agent_message.direction, "outgoing");
    }

    #[test]
    fn agent_task_rolls_back_all_records_when_queue_insert_fails() {
        let connection = test_connection();
        seed_agent_sender_and_service(&connection, "trusted");
        connection
            .execute_batch(
                "CREATE TRIGGER fail_agent_send_queue_insert
                 BEFORE INSERT ON send_queue
                 BEGIN
                   SELECT RAISE(ABORT, 'forced agent queue failure');
                 END;",
            )
            .expect("install failure trigger");

        let error = agent_send_task(
            &connection,
            AgentSendTaskRequest {
                agent_service_id: "agsvc_1".to_string(),
                sender_account_id: "acct_agent".to_string(),
                subject: "Must roll back".to_string(),
                body_text: "Please summarize this.".to_string(),
                confirm_restricted: false,
            },
            "2026-06-12T02:20:00Z".to_string(),
        )
        .expect_err("queue insert should fail");

        for table in ["messages", "agent_threads", "agent_messages", "send_queue"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count rolled back rows");
            assert_eq!(count, 0, "{table} should remain empty");
        }
        assert_eq!(error.code, "sqlite_agent_failed");
    }

    #[test]
    fn incoming_reply_links_by_in_reply_to() {
        let connection = test_connection();
        seed_agent_thread_with_outgoing_message(&connection);
        seed_incoming_agent_reply(&connection, "msg_reply", "remote-agent@example.test");

        let result = associate_incoming_agent_reply(
            &connection,
            AgentReplyAssociationRequest {
                message_id: "msg_reply".to_string(),
                from_address: "remote-agent@example.test".to_string(),
                in_reply_to_message_id: Some("<outgoing@example.test>".to_string()),
                references: Vec::new(),
            },
            "2026-06-12T02:30:00Z".to_string(),
        )
        .expect("associate reply");

        assert_eq!(result.status, "linked");
        assert_eq!(result.thread.status, "in_progress");
        assert_eq!(result.agent_message.direction, "incoming");
    }

    #[test]
    fn incoming_reply_does_not_link_thread_owned_by_another_agent_service() {
        let connection = test_connection();
        seed_agent_thread_with_outgoing_message(&connection);
        connection
            .execute(
                "INSERT INTO agent_services (
                    id, display_name, email_address, description, service_kind, trust_level,
                    default_sender_account_id, status, created_at, updated_at
                 ) VALUES (
                    'agsvc_2', 'Other Agent', 'other-agent@example.test', 'Other service',
                    'email_agent', 'trusted', 'acct_agent', 'active',
                    '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z'
                 )",
                [],
            )
            .expect("insert other service");
        seed_incoming_agent_reply(&connection, "msg_other_reply", "other-agent@example.test");

        let result = associate_incoming_agent_reply(
            &connection,
            AgentReplyAssociationRequest {
                message_id: "msg_other_reply".to_string(),
                from_address: "other-agent@example.test".to_string(),
                in_reply_to_message_id: Some("<outgoing@example.test>".to_string()),
                references: Vec::new(),
            },
            "2026-06-12T02:30:00Z".to_string(),
        )
        .expect("associate other service reply");

        assert_eq!(result.status, "needs_attention");
        assert_eq!(result.thread.agent_service_id, "agsvc_2");
        assert_ne!(result.thread.id, "agthread_1");
    }

    #[test]
    fn unmatched_agent_reply_goes_to_needs_attention() {
        let connection = test_connection();
        seed_agent_service_only(&connection);
        seed_incoming_agent_reply(&connection, "msg_unmatched", "remote-agent@example.test");

        let result = associate_incoming_agent_reply(
            &connection,
            AgentReplyAssociationRequest {
                message_id: "msg_unmatched".to_string(),
                from_address: "remote-agent@example.test".to_string(),
                in_reply_to_message_id: None,
                references: Vec::new(),
            },
            "2026-06-12T02:35:00Z".to_string(),
        )
        .expect("associate unmatched");

        assert_eq!(result.status, "needs_attention");
        assert_eq!(result.thread.status, "needs_attention");
        assert_eq!(result.agent_message.direction, "incoming");
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    fn seed_normal_sender_and_agent_service(connection: &Connection, trust_level: &str) {
        seed_sender(connection, "acct_normal", "normal", "normal_long_lived", 1);
        seed_agent_service(connection, trust_level, Some("acct_normal"));
    }

    fn seed_agent_sender_and_service(connection: &Connection, trust_level: &str) {
        seed_sender(connection, "acct_agent", "agent", "agent_owned", 0);
        seed_smtp_source(connection, "acct_agent");
        seed_agent_service(connection, trust_level, Some("acct_agent"));
    }

    fn seed_sender(
        connection: &Connection,
        account_id: &str,
        scope: &str,
        kind: &str,
        listed: i64,
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
                ) VALUES (?1, ?2, ?3, 'Sender', 'sender@example.test', 'Manual SMTP', 'ready', 'valid', 'enabled', 'enabled', ?4, '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
                rusqlite::params![account_id, scope, kind, listed],
            )
            .expect("insert sender");
    }

    fn seed_smtp_source(connection: &Connection, account_id: &str) {
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
                ) VALUES ('src_smtp', ?1, 'smtp', 'sender@example.test', 'smtp.example.test', '{\"host\":\"smtp.example.test\",\"port\":587,\"security\":\"starttls\",\"username\":\"sender@example.test\"}', 'cred_smtp', 'ready', '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
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
                ) VALUES ('cred_smtp', ?1, 'src_smtp', 'fake_vault', 'secret://smtp/acct_agent', 'smtp_password', 'password', 'active', '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
                rusqlite::params![account_id],
            )
            .expect("insert credential");
    }

    fn seed_agent_service(
        connection: &Connection,
        trust_level: &str,
        default_sender_account_id: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO agent_services (
                    id,
                    display_name,
                    email_address,
                    description,
                    service_kind,
                    trust_level,
                    default_sender_account_id,
                    status,
                    created_at,
                    updated_at
                ) VALUES ('agsvc_1', 'Remote Agent', 'remote-agent@example.test', 'Handles research tasks', 'email_agent', ?1, ?2, 'active', '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
                rusqlite::params![trust_level, default_sender_account_id],
            )
            .expect("insert service");
    }

    fn seed_agent_service_only(connection: &Connection) {
        seed_sender(connection, "acct_agent", "agent", "agent_owned", 0);
        seed_agent_service(connection, "trusted", Some("acct_agent"));
    }

    fn seed_agent_thread_with_outgoing_message(connection: &Connection) {
        seed_agent_service_only(connection);
        connection
            .execute(
                "INSERT INTO messages (
                    id,
                    rfc_message_id,
                    subject,
                    from_address,
                    snippet,
                    body_text_cache,
                    body_cache_state,
                    classification,
                    created_at,
                    updated_at
                ) VALUES ('msg_outgoing', '<outgoing@example.test>', 'Research task', 'agent@example.test', 'Please summarize', 'Please summarize', 'cached', 'outgoing', '2026-06-12T02:20:00Z', '2026-06-12T02:20:00Z')",
                [],
            )
            .expect("insert outgoing");
        connection
            .execute(
                "INSERT INTO agent_threads (
                    id,
                    agent_service_id,
                    sender_account_id,
                    subject,
                    status,
                    last_outgoing_message_id,
                    correlation_key,
                    created_at,
                    updated_at
                ) VALUES ('agthread_1', 'agsvc_1', 'acct_agent', 'Research task', 'awaiting_reply', 'msg_outgoing', 'corr_1', '2026-06-12T02:20:00Z', '2026-06-12T02:20:00Z')",
                [],
            )
            .expect("insert thread");
        connection
            .execute(
                "INSERT INTO agent_messages (
                    id,
                    thread_id,
                    message_id,
                    direction,
                    semantic_role,
                    parsed_status,
                    parsed_payload_json,
                    created_at
                ) VALUES ('agmsg_out', 'agthread_1', 'msg_outgoing', 'outgoing', 'task_request', 'queued', '{}', '2026-06-12T02:20:00Z')",
                [],
            )
            .expect("insert agent outgoing");
    }

    fn seed_incoming_agent_reply(connection: &Connection, message_id: &str, from_address: &str) {
        connection
            .execute(
                "INSERT INTO messages (
                    id,
                    rfc_message_id,
                    subject,
                    from_address,
                    snippet,
                    body_text_cache,
                    body_cache_state,
                    classification,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, 'Re: Research task', ?3, 'Reply body', 'Reply body', 'cached', 'normal', '2026-06-12T02:30:00Z', '2026-06-12T02:30:00Z')",
                rusqlite::params![message_id, format!("<{message_id}@example.test>"), from_address],
            )
            .expect("insert incoming reply");
    }
}
