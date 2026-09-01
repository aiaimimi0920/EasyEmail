use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::easyemail::adapter::EasyEmailAdapter;
use crate::easyemail::models::{
    CreateTempMailboxRequest, EasyEmailConnectionSettings, EasyEmailHealth,
    EasyEmailObservedMessage, EasyEmailTempMailbox, FetchTempMessagesRequest,
};
use crate::error::AppError;

#[derive(Debug, Clone)]
pub struct FakeEasyEmailAdapter {
    health: Result<EasyEmailHealth, AppError>,
    mailbox: Result<EasyEmailTempMailbox, AppError>,
    observed_messages: HashMap<String, Result<Vec<EasyEmailObservedMessage>, AppError>>,
    fetch_calls: Arc<Mutex<Vec<String>>>,
}

impl FakeEasyEmailAdapter {
    pub fn healthy(provider_count: usize) -> Self {
        Self {
            health: Ok(EasyEmailHealth {
                reachable: true,
                provider_count,
                auth_status: "not_required".to_string(),
                capabilities_summary: format!("{provider_count} provider types available"),
            }),
            mailbox: Ok(EasyEmailTempMailbox {
                email_address: "code@example.test".to_string(),
                provider_id: "fake".to_string(),
                provider_label: "Fake Provider".to_string(),
                easyemail_mailbox_id: Some("easyemail_session_fake".to_string()),
                lease_expires_at: Some("2026-06-12T01:00:00Z".to_string()),
                raw_provider_snapshot_json: serde_json::json!({
                    "session": {
                        "id": "easyemail_session_fake",
                        "emailAddress": "code@example.test"
                    },
                    "instance": {
                        "providerTypeKey": "fake",
                        "displayName": "Fake Provider"
                    }
                }),
            }),
            observed_messages: HashMap::new(),
            fetch_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn with_mailbox(mailbox: EasyEmailTempMailbox) -> Self {
        Self {
            mailbox: Ok(mailbox),
            ..Self::healthy(1)
        }
    }

    pub fn failing(error: AppError) -> Self {
        Self {
            health: Err(error.clone()),
            mailbox: Err(error),
            observed_messages: HashMap::new(),
            fetch_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn with_observed_messages(
        mut self,
        session_id: impl Into<String>,
        messages: Vec<EasyEmailObservedMessage>,
    ) -> Self {
        self.observed_messages
            .insert(session_id.into(), Ok(messages));
        self
    }

    pub fn with_observed_error(mut self, session_id: impl Into<String>, error: AppError) -> Self {
        self.observed_messages.insert(session_id.into(), Err(error));
        self
    }

    pub fn fetch_calls(&self) -> Vec<String> {
        self.fetch_calls
            .lock()
            .expect("fake fetch call lock")
            .clone()
    }
}

impl EasyEmailAdapter for FakeEasyEmailAdapter {
    fn health_check(
        &self,
        _settings: &EasyEmailConnectionSettings,
    ) -> Result<EasyEmailHealth, AppError> {
        self.health.clone()
    }

    fn create_temp_mailbox(
        &self,
        _settings: &EasyEmailConnectionSettings,
        _request: &CreateTempMailboxRequest,
    ) -> Result<EasyEmailTempMailbox, AppError> {
        self.mailbox.clone()
    }

    fn fetch_temp_messages(
        &self,
        _settings: &EasyEmailConnectionSettings,
        request: &FetchTempMessagesRequest,
    ) -> Result<Vec<EasyEmailObservedMessage>, AppError> {
        self.fetch_calls
            .lock()
            .expect("fake fetch call lock")
            .push(request.easyemail_mailbox_id.clone());
        self.observed_messages
            .get(&request.easyemail_mailbox_id)
            .cloned()
            .unwrap_or_else(|| Ok(Vec::new()))
    }
}

#[cfg(test)]
mod tests {
    use crate::easyemail::adapter::EasyEmailAdapter;
    use crate::easyemail::models::EasyEmailConnectionSettings;

    use super::*;

    #[test]
    fn easyemail_health_success_maps_to_dto() {
        let adapter = FakeEasyEmailAdapter::healthy(3);
        let settings = EasyEmailConnectionSettings {
            service_url: "http://127.0.0.1:8080".to_string(),
            api_token: None,
        };

        let health = adapter.health_check(&settings).expect("fake health");

        assert!(health.reachable);
        assert_eq!(health.provider_count, 3);
        assert_eq!(health.auth_status, "not_required");
        assert_eq!(health.capabilities_summary, "3 provider types available");
    }

    #[test]
    fn fake_adapter_records_fetch_session_ids() {
        let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
            "session_1",
            vec![crate::easyemail::models::EasyEmailObservedMessage {
                id: "observed_1".to_string(),
                session_id: "session_1".to_string(),
                provider_instance_id: "provider_instance_1".to_string(),
                observed_at: "2026-06-12T00:10:00Z".to_string(),
                sender: Some("noreply@example.test".to_string()),
                subject: Some("Your code is 123456".to_string()),
                text_body: Some("Use 123456 to continue.".to_string()),
                html_body: None,
                raw_json: serde_json::json!({"id": "observed_1"}),
            }],
        );
        let settings = EasyEmailConnectionSettings {
            service_url: "http://127.0.0.1:8080".to_string(),
            api_token: None,
        };

        let messages = adapter
            .fetch_temp_messages(
                &settings,
                &crate::easyemail::models::FetchTempMessagesRequest {
                    easyemail_mailbox_id: "session_1".to_string(),
                    force_sync: true,
                    limit: None,
                },
            )
            .expect("fetch messages");

        assert_eq!(messages.len(), 1);
        assert_eq!(adapter.fetch_calls(), vec!["session_1".to_string()]);
    }
}
