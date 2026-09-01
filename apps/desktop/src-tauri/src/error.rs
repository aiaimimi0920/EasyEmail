use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Auth,
    Network,
    Provider,
    Protocol,
    Storage,
    Validation,
    RateLimit,
    Unsupported,
    Internal,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionRequired {
    Reauthorize,
    EditSettings,
    Wait,
    Retry,
    Confirm,
    UnlockVault,
    CheckEasyEmailConnection,
    None,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ErrorDto {
    pub code: String,
    pub category: ErrorCategory,
    pub user_message: String,
    pub technical_message: Option<String>,
    pub retryable: bool,
    pub action_required: ActionRequired,
    pub correlation_id: String,
    pub metadata: Box<Value>,
}

#[derive(Debug, Clone, Error)]
#[error("{code}: {user_message}")]
pub struct AppError {
    pub code: String,
    pub category: ErrorCategory,
    pub user_message: String,
    pub technical_message: Option<String>,
    pub retryable: bool,
    pub action_required: ActionRequired,
    pub correlation_id: String,
    pub metadata: Box<Value>,
}

impl AppError {
    pub fn internal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            category: ErrorCategory::Internal,
            user_message: message.into(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: Uuid::new_v4().to_string(),
            metadata: Box::new(Value::Object(Default::default())),
        }
    }

    pub fn to_dto(&self) -> ErrorDto {
        ErrorDto {
            code: self.code.clone(),
            category: self.category.clone(),
            user_message: self.user_message.clone(),
            technical_message: self
                .technical_message
                .as_deref()
                .map(crate::redaction::redact_text),
            retryable: self.retryable,
            action_required: self.action_required.clone(),
            correlation_id: self.correlation_id.clone(),
            metadata: Box::new(crate::redaction::redact_json(&self.metadata)),
        }
    }
}

impl From<AppError> for ErrorDto {
    fn from(value: AppError) -> Self {
        value.to_dto()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_error_serialization_has_code_category_user_message() {
        let error = AppError {
            code: "keychain_unavailable".to_string(),
            category: ErrorCategory::Storage,
            user_message: "Secure storage is unavailable.".to_string(),
            technical_message: Some("windows credential manager returned 5".to_string()),
            retryable: false,
            action_required: ActionRequired::UnlockVault,
            correlation_id: "corr_1".to_string(),
            metadata: Box::new(json!({"password": "secret"})),
        };

        let dto = error.to_dto();

        assert_eq!(dto.code, "keychain_unavailable");
        assert_eq!(dto.category, ErrorCategory::Storage);
        assert_eq!(dto.user_message, "Secure storage is unavailable.");
        assert_eq!(dto.action_required, ActionRequired::UnlockVault);
        assert_eq!(dto.metadata["password"], "[REDACTED]");
    }

    #[test]
    fn app_error_redacts_technical_messages_before_crossing_the_command_boundary() {
        let error = AppError {
            code: "network_failed".to_string(),
            category: ErrorCategory::Network,
            user_message: "The request failed.".to_string(),
            technical_message: Some("request failed api_key=super-secret".to_string()),
            retryable: true,
            action_required: ActionRequired::Retry,
            correlation_id: "corr_2".to_string(),
            metadata: Box::new(json!({})),
        };

        let dto = error.to_dto();

        assert_eq!(
            dto.technical_message.as_deref(),
            Some("request failed api_key=[REDACTED]")
        );
    }
}
