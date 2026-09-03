use rusqlite::Connection;
use uuid::Uuid;

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::storage::account_repository::{get_account, get_smtp_source_for_account};
use crate::storage::agent_repository::{
    create_agent_thread, find_agent_thread_by_outgoing_rfc_message_id, get_agent_service,
    get_agent_service_by_email, get_agent_thread, insert_agent_message,
    update_agent_thread_after_incoming, update_agent_thread_after_outgoing, AgentThreadRow,
    NewAgentMessage, NewAgentThread,
};
use crate::storage::message_repository::{
    get_message_for_agent_association, insert_outgoing_message, NewOutgoingMessage,
};
use crate::storage::send_queue_repository::{enqueue_send, NewSendQueueItem};

#[path = "agent_service_models.rs"]
mod models;

pub use models::{
    AgentReplyAssociationRequest, AgentReplyAssociationResult, AgentSendTaskRequest,
    AgentSendTaskResult,
};

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
#[path = "agent_service_tests.rs"]
mod tests;
