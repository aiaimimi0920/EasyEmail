use uuid::Uuid;

use crate::error::{ActionRequired, AppError, ErrorCategory};

use super::{AgentReplyAssociationRequest, AgentSendTaskRequest};

pub(super) fn normalize_agent_send_task_request(
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

pub(super) fn normalize_agent_reply_association_request(
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

fn normalize_header_message_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub(super) fn dedupe_non_empty(values: Vec<String>) -> Vec<String> {
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

pub(super) fn validate_agent_service_trust(
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

pub(super) fn agent_sender_scope_required(account_id: &str) -> AppError {
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

pub(super) fn agent_sender_send_not_enabled(account_id: &str, send_status: &str) -> AppError {
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

pub(super) fn agent_sender_not_found(account_id: &str) -> AppError {
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

pub(super) fn agent_sender_smtp_missing(account_id: &str) -> AppError {
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

pub(super) fn agent_service_not_found(agent_service_id: &str) -> AppError {
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

pub(super) fn agent_thread_missing_after_send(thread_id: &str) -> AppError {
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

pub(super) fn agent_reply_message_not_found(message_id: &str) -> AppError {
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

pub(super) fn agent_service_unknown(from_address: &str) -> AppError {
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

pub(super) fn agent_service_default_sender_missing(agent_service_id: &str) -> AppError {
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

pub(super) fn agent_thread_missing_after_reply(thread_id: &str) -> AppError {
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

pub(super) fn storage_error(error: rusqlite::Error) -> AppError {
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
