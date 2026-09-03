use super::*;

pub(super) fn lock_error(
    err: std::sync::PoisonError<std::sync::MutexGuard<'_, rusqlite::Connection>>,
) -> ErrorDto {
    AppError {
        code: "sqlite_connection_lock_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "The local database is temporarily unavailable.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}

pub(super) fn message_list_error(err: rusqlite::Error) -> ErrorDto {
    AppError {
        code: "message_list_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Messages could not be loaded.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}

pub(super) fn message_action_error(err: rusqlite::Error) -> ErrorDto {
    AppError {
        code: "message_action_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "The selected message action could not be saved locally.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}

pub(super) fn message_label_invalid(label_name: &str) -> ErrorDto {
    AppError {
        code: "message_label_invalid".to_string(),
        category: ErrorCategory::Validation,
        user_message: "This local message label is not valid.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "label_name": label_name })),
    }
    .to_dto()
}
