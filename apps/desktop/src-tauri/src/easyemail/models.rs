use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::{Host, Url};

use crate::error::{ActionRequired, AppError, ErrorCategory};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EasyEmailConnectionSettings {
    pub service_url: String,
    pub api_token: Option<String>,
}

impl EasyEmailConnectionSettings {
    pub fn normalized_base_url(&self) -> Result<String, AppError> {
        validate_easyemail_service_url(&self.service_url)
    }
}

pub fn validate_easyemail_service_url(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    let mut parsed = Url::parse(value).map_err(|_| invalid_easyemail_service_url())?;
    let is_loopback = match parsed.host().ok_or_else(invalid_easyemail_service_url)? {
        Host::Domain(host) => host.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    };
    let has_credentials = !parsed.username().is_empty() || parsed.password().is_some();
    let has_extra_components = !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some();
    let valid_transport = parsed.scheme() == "https" || (parsed.scheme() == "http" && is_loopback);

    if has_credentials || has_extra_components || !valid_transport {
        return Err(invalid_easyemail_service_url());
    }

    parsed.set_path("");
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn invalid_easyemail_service_url() -> AppError {
    AppError {
        code: "easyemail_service_url_invalid".to_string(),
        category: ErrorCategory::Validation,
        user_message: "Enter an HTTPS EasyEmail service URL, or use HTTP only for localhost."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EasyEmailHealth {
    pub reachable: bool,
    pub provider_count: usize,
    pub auth_status: String,
    pub capabilities_summary: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateTempMailboxRequest {
    pub target_service: Option<String>,
    pub provider_selection: Option<String>,
    pub domain_selection: Option<String>,
    pub local_part: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FetchTempMessagesRequest {
    pub easyemail_mailbox_id: String,
    pub force_sync: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EasyEmailTempMailbox {
    pub email_address: String,
    pub provider_id: String,
    pub provider_label: String,
    pub easyemail_mailbox_id: Option<String>,
    pub lease_expires_at: Option<String>,
    pub raw_provider_snapshot_json: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EasyEmailObservedMessage {
    pub id: String,
    pub session_id: String,
    pub provider_instance_id: String,
    pub observed_at: String,
    pub sender: Option<String>,
    pub subject: Option<String>,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    pub raw_json: Value,
}

impl EasyEmailObservedMessage {
    pub fn from_value(value: Value) -> Result<Self, AppError> {
        Ok(Self {
            id: required_observed_string(&value, "id")?,
            session_id: required_observed_string(&value, "sessionId")?,
            provider_instance_id: required_observed_string(&value, "providerInstanceId")?,
            observed_at: required_observed_string(&value, "observedAt")?,
            sender: string_field(&value, "sender"),
            subject: string_field(&value, "subject"),
            text_body: string_field(&value, "textBody"),
            html_body: string_field(&value, "htmlBody"),
            raw_json: value,
        })
    }
}

impl EasyEmailTempMailbox {
    pub fn from_open_result(result: Value) -> Result<Self, AppError> {
        let session = result.get("session").ok_or_else(|| {
            open_result_mapping_error("EasyEmail open result did not include a session object.")
        })?;
        let instance = result.get("instance").unwrap_or(&Value::Null);

        let email_address = required_string(session, "emailAddress")?;
        let provider_id = string_field(session, "providerTypeKey")
            .or_else(|| string_field(instance, "providerTypeKey"))
            .or_else(|| string_field(session, "providerInstanceId"))
            .unwrap_or_else(|| "unknown".to_string());
        let provider_label = string_field(instance, "displayName")
            .or_else(|| string_field(instance, "id"))
            .unwrap_or_else(|| provider_id.clone());
        let easyemail_mailbox_id =
            string_field(session, "id").or_else(|| string_field(session, "mailboxRef"));
        let lease_expires_at = string_field(session, "expiresAt");

        Ok(Self {
            email_address,
            provider_id,
            provider_label,
            easyemail_mailbox_id,
            lease_expires_at,
            raw_provider_snapshot_json: result,
        })
    }
}

fn required_string(value: &Value, key: &str) -> Result<String, AppError> {
    string_field(value, key).ok_or_else(|| {
        open_result_mapping_error(format!(
            "EasyEmail open result missed required field {key}."
        ))
    })
}

fn required_observed_string(value: &Value, key: &str) -> Result<String, AppError> {
    string_field(value, key).ok_or_else(|| {
        observed_message_mapping_error(format!(
            "EasyEmail observed message missed required field {key}."
        ))
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn open_result_mapping_error(message: impl Into<String>) -> AppError {
    AppError {
        code: "easyemail_response_invalid".to_string(),
        category: ErrorCategory::Protocol,
        user_message: "EasyEmail returned a response EasyEmailAM could not understand.".to_string(),
        technical_message: Some(message.into()),
        retryable: false,
        action_required: ActionRequired::CheckEasyEmailConnection,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "endpoint": "/mail/mailboxes/open" })),
    }
}

fn observed_message_mapping_error(message: impl Into<String>) -> AppError {
    AppError {
        code: "easyemail_response_invalid".to_string(),
        category: ErrorCategory::Protocol,
        user_message: "EasyEmail returned a message EasyEmailAM could not understand.".to_string(),
        technical_message: Some(message.into()),
        retryable: false,
        action_required: ActionRequired::CheckEasyEmailConnection,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "endpoint": "/mail/query/observed-messages" })),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn http_open_mailbox_maps_canonical_fields() {
        let raw = json!({
            "session": {
                "id": "session_1",
                "hostId": "easyemailam",
                "providerTypeKey": "mailtm",
                "providerInstanceId": "provider_instance_1",
                "emailAddress": "code@example.test",
                "mailboxRef": "mailbox_ref_1",
                "status": "open",
                "createdAt": "2026-06-12T00:00:00Z",
                "expiresAt": "2026-06-12T01:00:00Z",
                "metadata": {}
            },
            "instance": {
                "id": "provider_instance_1",
                "providerTypeKey": "mailtm",
                "displayName": "Mail.tm",
                "status": "active"
            }
        });

        let mapped = EasyEmailTempMailbox::from_open_result(raw.clone()).expect("map open result");

        assert_eq!(mapped.email_address, "code@example.test");
        assert_eq!(mapped.provider_id, "mailtm");
        assert_eq!(mapped.provider_label, "Mail.tm");
        assert_eq!(mapped.easyemail_mailbox_id, Some("session_1".to_string()));
        assert_eq!(
            mapped.lease_expires_at,
            Some("2026-06-12T01:00:00Z".to_string())
        );
        assert_eq!(mapped.raw_provider_snapshot_json, raw);
    }

    #[test]
    fn observed_message_maps_canonical_fields() {
        let raw = json!({
            "id": "observed_1",
            "sessionId": "session_1",
            "providerInstanceId": "provider_instance_1",
            "observedAt": "2026-06-12T00:10:00Z",
            "sender": "noreply@example.test",
            "subject": "Your code is 123456",
            "textBody": "Use 123456 to continue.",
            "htmlBody": "<p>Use 123456 to continue.</p>"
        });

        let mapped =
            EasyEmailObservedMessage::from_value(raw.clone()).expect("map observed message");

        assert_eq!(mapped.id, "observed_1");
        assert_eq!(mapped.session_id, "session_1");
        assert_eq!(mapped.provider_instance_id, "provider_instance_1");
        assert_eq!(mapped.observed_at, "2026-06-12T00:10:00Z");
        assert_eq!(mapped.sender, Some("noreply@example.test".to_string()));
        assert_eq!(mapped.subject, Some("Your code is 123456".to_string()));
        assert_eq!(
            mapped.text_body,
            Some("Use 123456 to continue.".to_string())
        );
        assert_eq!(
            mapped.html_body,
            Some("<p>Use 123456 to continue.</p>".to_string())
        );
        assert_eq!(mapped.raw_json, raw);
    }
}
