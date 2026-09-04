use std::time::Duration;

use serde_json::Value;

use crate::easyemail::adapter::EasyEmailAdapter;
use crate::easyemail::models::{
    CreateTempMailboxRequest, EasyEmailConnectionSettings, EasyEmailHealth,
    EasyEmailObservedMessage, EasyEmailTempMailbox, FetchTempMessagesRequest,
};
use crate::error::AppError;

#[path = "http_protocol.rs"]
mod protocol;

use protocol::{
    invalid_json_error, map_ureq_error, observed_messages_route, open_mailbox_payload,
    CATALOG_ROUTE, OBSERVED_MESSAGES_ROUTE, OPEN_MAILBOX_ROUTE,
};

#[derive(Debug, Clone)]
pub struct HttpEasyEmailAdapter {
    timeout: Duration,
}

impl Default for HttpEasyEmailAdapter {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
        }
    }
}

impl HttpEasyEmailAdapter {
    pub fn with_timeout_millis(timeout_millis: u64) -> Self {
        Self {
            timeout: Duration::from_millis(timeout_millis),
        }
    }

    fn agent(&self) -> ureq::Agent {
        ureq::AgentBuilder::new().timeout(self.timeout).build()
    }

    fn endpoint(settings: &EasyEmailConnectionSettings, route: &str) -> Result<String, AppError> {
        Ok(format!("{}{}", settings.normalized_base_url()?, route))
    }

    fn apply_headers(
        request: ureq::Request,
        settings: &EasyEmailConnectionSettings,
    ) -> ureq::Request {
        let request = request.set("Accept", "application/json");
        match settings.api_token.as_ref().map(|token| token.trim()) {
            Some(token) if !token.is_empty() => {
                request.set("Authorization", &format!("Bearer {token}"))
            }
            _ => request,
        }
    }
}

impl EasyEmailAdapter for HttpEasyEmailAdapter {
    fn health_check(
        &self,
        settings: &EasyEmailConnectionSettings,
    ) -> Result<EasyEmailHealth, AppError> {
        let endpoint = Self::endpoint(settings, CATALOG_ROUTE)?;
        let response = Self::apply_headers(self.agent().get(&endpoint), settings)
            .call()
            .map_err(|err| map_ureq_error(err, CATALOG_ROUTE))?;
        let body: Value = response
            .into_json()
            .map_err(|err| invalid_json_error(CATALOG_ROUTE, err.to_string()))?;
        let catalog = body.get("catalog").unwrap_or(&body);
        let provider_count = catalog
            .get("providerTypes")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let capabilities_summary = if provider_count == 1 {
            "1 provider type available".to_string()
        } else {
            format!("{provider_count} provider types available")
        };

        Ok(EasyEmailHealth {
            reachable: true,
            provider_count,
            auth_status: "not_required".to_string(),
            capabilities_summary,
        })
    }

    fn create_temp_mailbox(
        &self,
        settings: &EasyEmailConnectionSettings,
        request: &CreateTempMailboxRequest,
    ) -> Result<EasyEmailTempMailbox, AppError> {
        let endpoint = Self::endpoint(settings, OPEN_MAILBOX_ROUTE)?;
        let payload = open_mailbox_payload(request);
        let response = Self::apply_headers(self.agent().post(&endpoint), settings)
            .set("Content-Type", "application/json")
            .send_json(payload)
            .map_err(|err| map_ureq_error(err, OPEN_MAILBOX_ROUTE))?;
        let body: Value = response
            .into_json()
            .map_err(|err| invalid_json_error(OPEN_MAILBOX_ROUTE, err.to_string()))?;
        let result = body.get("result").cloned().unwrap_or(body);

        EasyEmailTempMailbox::from_open_result(result)
    }

    fn fetch_temp_messages(
        &self,
        settings: &EasyEmailConnectionSettings,
        request: &FetchTempMessagesRequest,
    ) -> Result<Vec<EasyEmailObservedMessage>, AppError> {
        let route = observed_messages_route(request);
        let endpoint = Self::endpoint(settings, &route)?;
        let response = Self::apply_headers(self.agent().get(&endpoint), settings)
            .call()
            .map_err(|err| map_ureq_error(err, OBSERVED_MESSAGES_ROUTE))?;
        let body: Value = response
            .into_json()
            .map_err(|err| invalid_json_error(OBSERVED_MESSAGES_ROUTE, err.to_string()))?;
        let messages = body
            .get("messages")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                invalid_json_error(
                    OBSERVED_MESSAGES_ROUTE,
                    "EasyEmail response did not include messages array.".to_string(),
                )
            })?;

        messages
            .iter()
            .cloned()
            .map(EasyEmailObservedMessage::from_value)
            .collect()
    }
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
