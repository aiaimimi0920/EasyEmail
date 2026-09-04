use serde_json::{json, Value};

use crate::easyemail::models::{CreateTempMailboxRequest, FetchTempMessagesRequest};
use crate::error::{ActionRequired, AppError, ErrorCategory};

pub(super) const CATALOG_ROUTE: &str = "/mail/catalog";
pub(super) const OPEN_MAILBOX_ROUTE: &str = "/mail/mailboxes/open";
pub(super) const OBSERVED_MESSAGES_ROUTE: &str = "/mail/query/observed-messages";

pub(super) fn observed_messages_route(request: &FetchTempMessagesRequest) -> String {
    let mut route = format!(
        "{OBSERVED_MESSAGES_ROUTE}?sessionId={}&sync={}&newestFirst=true",
        percent_encode_component(&request.easyemail_mailbox_id),
        request.force_sync
    );
    if let Some(limit) = request.limit {
        route.push_str("&limit=");
        route.push_str(&limit.to_string());
    }
    route
}

fn percent_encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

pub(super) fn open_mailbox_payload(request: &CreateTempMailboxRequest) -> Value {
    let mut payload = json!({
        "hostId": request
            .target_service
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("easyemailam"),
        "provisionMode": "auto-create-if-missing",
        "bindingMode": "shared-instance"
    });

    insert_optional_string(
        &mut payload,
        "providerTypeKey",
        request.provider_selection.as_deref(),
    );
    insert_optional_string(
        &mut payload,
        "requestedDomain",
        request.domain_selection.as_deref(),
    );
    insert_optional_string(
        &mut payload,
        "requestedLocalPart",
        request.local_part.as_deref(),
    );

    if let Some(note) = request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        payload["metadata"] = json!({ "note": note });
    }

    payload
}

fn insert_optional_string(payload: &mut Value, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        payload[key] = Value::String(value.to_string());
    }
}

pub(super) fn invalid_json_error(endpoint: &'static str, _message: String) -> AppError {
    AppError {
        code: "easyemail_response_invalid".to_string(),
        category: ErrorCategory::Protocol,
        user_message: "EasyEmail returned a response EasyEmailAM could not understand.".to_string(),
        technical_message: Some(format!("EasyEmail returned invalid JSON at {endpoint}")),
        retryable: false,
        action_required: ActionRequired::CheckEasyEmailConnection,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(json!({ "endpoint": endpoint })),
    }
}

pub(super) fn map_ureq_error(error: ureq::Error, endpoint: &'static str) -> AppError {
    match error {
        ureq::Error::Status(status, response) => {
            drop(response);
            let (category, retryable, action_required, code) = match status {
                401 | 403 => (
                    ErrorCategory::Auth,
                    false,
                    ActionRequired::EditSettings,
                    "easyemail_auth_failed",
                ),
                429 => (
                    ErrorCategory::RateLimit,
                    true,
                    ActionRequired::Wait,
                    "easyemail_rate_limited",
                ),
                500..=599 => (
                    ErrorCategory::Provider,
                    true,
                    ActionRequired::Retry,
                    "easyemail_provider_unavailable",
                ),
                _ => (
                    ErrorCategory::Protocol,
                    false,
                    ActionRequired::CheckEasyEmailConnection,
                    "easyemail_request_failed",
                ),
            };

            AppError {
                code: code.to_string(),
                category,
                user_message: match status {
                    401 | 403 => "EasyEmail rejected the supplied credentials.".to_string(),
                    429 => {
                        "EasyEmail is rate limiting mailbox creation. Wait and retry.".to_string()
                    }
                    500..=599 => "EasyEmail is temporarily unavailable.".to_string(),
                    _ => format!("EasyEmail returned HTTP {status}."),
                },
                technical_message: Some(format!("EasyEmail HTTP status {status} at {endpoint}")),
                retryable,
                action_required,
                correlation_id: uuid::Uuid::new_v4().to_string(),
                metadata: Box::new(json!({ "endpoint": endpoint, "status": status })),
            }
        }
        ureq::Error::Transport(_) => AppError {
            code: "easyemail_unreachable".to_string(),
            category: ErrorCategory::Network,
            user_message:
                "EasyEmail is unreachable. Check the service URL and whether it is running."
                    .to_string(),
            technical_message: Some(format!("EasyEmail transport failed at {endpoint}")),
            retryable: true,
            action_required: ActionRequired::CheckEasyEmailConnection,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(json!({ "endpoint": endpoint })),
        },
    }
}
