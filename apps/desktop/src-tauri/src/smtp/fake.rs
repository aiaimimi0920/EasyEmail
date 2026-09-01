use std::sync::{Arc, Mutex};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::smtp::adapter::SmtpAdapter;
use crate::smtp::models::{
    SmtpConnectionProfile, SmtpConnectionTestResult, SmtpSendMessage, SmtpSendResult,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum FakeSmtpMode {
    Success,
    RetryableFailure,
    AuthFailure,
}

#[derive(Debug, Clone)]
pub struct FakeSmtpAdapter {
    mode: FakeSmtpMode,
    sent_messages: Arc<Mutex<Vec<SmtpSendMessage>>>,
}

impl FakeSmtpAdapter {
    pub fn success() -> Self {
        Self {
            mode: FakeSmtpMode::Success,
            sent_messages: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn retryable_failure() -> Self {
        Self {
            mode: FakeSmtpMode::RetryableFailure,
            sent_messages: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn auth_failure() -> Self {
        Self {
            mode: FakeSmtpMode::AuthFailure,
            sent_messages: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn sent_messages(&self) -> Vec<SmtpSendMessage> {
        self.sent_messages
            .lock()
            .expect("fake smtp sent message lock")
            .clone()
    }
}

impl SmtpAdapter for FakeSmtpAdapter {
    fn test_connection(
        &self,
        _profile: &SmtpConnectionProfile,
        _secret: &str,
    ) -> Result<SmtpConnectionTestResult, AppError> {
        match self.mode {
            FakeSmtpMode::Success => Ok(SmtpConnectionTestResult {
                authenticated: true,
                capability_summary: "fake-smtp-ready".to_string(),
            }),
            FakeSmtpMode::RetryableFailure => Err(smtp_retryable_error()),
            FakeSmtpMode::AuthFailure => Err(smtp_auth_failed()),
        }
    }

    fn send_message(
        &self,
        _profile: &SmtpConnectionProfile,
        _secret: &str,
        message: &SmtpSendMessage,
    ) -> Result<SmtpSendResult, AppError> {
        match self.mode {
            FakeSmtpMode::Success => {
                self.sent_messages
                    .lock()
                    .map_err(|error| {
                        AppError::internal("fake_smtp_sent_messages_lock_failed", error.to_string())
                    })?
                    .push(message.clone());
                Ok(SmtpSendResult {
                    provider_message_id: Some("fake-smtp-message-id".to_string()),
                })
            }
            FakeSmtpMode::RetryableFailure => Err(smtp_retryable_error()),
            FakeSmtpMode::AuthFailure => Err(smtp_auth_failed()),
        }
    }
}

fn smtp_retryable_error() -> AppError {
    AppError {
        code: "smtp_retryable_failure".to_string(),
        category: ErrorCategory::Network,
        user_message: "The SMTP server could not be reached. EasyEmailAM will retry.".to_string(),
        technical_message: Some("fake retryable SMTP failure".to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "fake_smtp" })),
    }
}

fn smtp_auth_failed() -> AppError {
    AppError {
        code: "smtp_auth_failed".to_string(),
        category: ErrorCategory::Auth,
        user_message: "The SMTP server rejected the supplied credentials.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "fake_smtp" })),
    }
}

#[cfg(test)]
mod tests {
    use crate::smtp::adapter::SmtpAdapter;
    use crate::smtp::models::{SmtpConnectionProfile, SmtpSendMessage};

    use super::*;

    #[test]
    fn fake_smtp_adapter_sends_message() {
        let adapter = FakeSmtpAdapter::success();
        let profile = SmtpConnectionProfile {
            host: "smtp.example.test".to_string(),
            port: 587,
            security: "starttls".to_string(),
            username: "sender@example.test".to_string(),
        };
        let message = SmtpSendMessage {
            from_address: "sender@example.test".to_string(),
            to_addresses: vec!["target@example.test".to_string()],
            cc_addresses: vec!["cc@example.test".to_string()],
            bcc_addresses: vec!["bcc@example.test".to_string()],
            subject: "Hello".to_string(),
            body_text: "Queued body".to_string(),
        };

        let result = adapter
            .send_message(&profile, "app-password", &message)
            .expect("send message");

        assert_eq!(
            result.provider_message_id,
            Some("fake-smtp-message-id".to_string())
        );
        let sent_messages = adapter.sent_messages();
        assert_eq!(sent_messages.len(), 1);
        assert_eq!(sent_messages[0].cc_addresses, vec!["cc@example.test"]);
        assert_eq!(sent_messages[0].bcc_addresses, vec!["bcc@example.test"]);
    }
}
