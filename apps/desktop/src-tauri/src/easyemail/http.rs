use std::time::Duration;

use serde_json::{json, Value};

use crate::easyemail::adapter::EasyEmailAdapter;
use crate::easyemail::models::{
    CreateTempMailboxRequest, EasyEmailConnectionSettings, EasyEmailHealth,
    EasyEmailObservedMessage, EasyEmailTempMailbox, FetchTempMessagesRequest,
};
use crate::error::{ActionRequired, AppError, ErrorCategory};

const CATALOG_ROUTE: &str = "/mail/catalog";
const OPEN_MAILBOX_ROUTE: &str = "/mail/mailboxes/open";
const OBSERVED_MESSAGES_ROUTE: &str = "/mail/query/observed-messages";

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

fn observed_messages_route(request: &FetchTempMessagesRequest) -> String {
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

fn open_mailbox_payload(request: &CreateTempMailboxRequest) -> Value {
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

fn invalid_json_error(endpoint: &'static str, _message: String) -> AppError {
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

fn map_ureq_error(error: ureq::Error, endpoint: &'static str) -> AppError {
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

#[cfg(test)]
mod tests {
    use std::io::{ErrorKind, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use crate::easyemail::adapter::EasyEmailAdapter;
    use crate::easyemail::models::{CreateTempMailboxRequest, EasyEmailConnectionSettings};
    use crate::error::{ActionRequired, ErrorCategory};

    use super::*;

    fn serve_once(body: &'static str) -> String {
        serve_once_with_status("200 OK", body)
    }

    fn serve_once_with_status(status: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("server address");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let _ = read_http_request(&mut stream);
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        format!("http://{address}")
    }

    fn serve_once_capture(body: &'static str) -> (String, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("server address");
        let captured = Arc::new(Mutex::new(String::new()));
        let captured_for_thread = Arc::clone(&captured);
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            *captured_for_thread.lock().expect("lock captured request") =
                read_http_request(&mut stream);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        (format!("http://{address}"), captured)
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("set test read timeout");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];

        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    request.extend_from_slice(&buffer[..size]);
                    if http_request_complete(&request) {
                        break;
                    }
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    break;
                }
                Err(error) => panic!("read request: {error}"),
            }
        }

        String::from_utf8_lossy(&request).to_string()
    }

    fn http_request_complete(request: &[u8]) -> bool {
        let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            return false;
        };
        let body_start = header_end + 4;
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);

        request.len() >= body_start + content_length
    }

    #[test]
    fn http_easyemail_health_success_maps_catalog() {
        let base_url = serve_once(
            r#"{"catalog":{"providerTypes":[{"key":"mailtm"},{"key":"m2u"}],"supportsStrategyMode":true}}"#,
        );
        let adapter = HttpEasyEmailAdapter::with_timeout_millis(1_000);
        let settings = EasyEmailConnectionSettings {
            service_url: base_url,
            api_token: None,
        };

        let health = adapter.health_check(&settings).expect("health check");

        assert!(health.reachable);
        assert_eq!(health.provider_count, 2);
        assert_eq!(health.auth_status, "not_required");
    }

    #[test]
    fn easyemail_unreachable_maps_to_retryable_error() {
        let adapter = HttpEasyEmailAdapter::with_timeout_millis(200);
        let settings = EasyEmailConnectionSettings {
            service_url: "http://127.0.0.1:9".to_string(),
            api_token: Some("one-shot-token".to_string()),
        };

        let error = adapter
            .health_check(&settings)
            .expect_err("unreachable service should fail");

        assert_eq!(error.category, ErrorCategory::Network);
        assert!(error.retryable);
        assert_eq!(
            error.action_required,
            ActionRequired::CheckEasyEmailConnection
        );
        assert!(!error
            .to_dto()
            .metadata
            .to_string()
            .contains("one-shot-token"));
        assert!(!error
            .to_dto()
            .technical_message
            .as_deref()
            .unwrap_or_default()
            .contains("one-shot-token"));
    }

    #[test]
    fn invalid_provider_json_does_not_expose_response_body() {
        let base_url = serve_once(r#"{"catalog": [parser-secret=should-not-leak}"#);
        let adapter = HttpEasyEmailAdapter::with_timeout_millis(1_000);
        let settings = EasyEmailConnectionSettings {
            service_url: base_url,
            api_token: None,
        };

        let error = adapter
            .health_check(&settings)
            .expect_err("invalid provider JSON should fail");
        let dto = error.to_dto();

        assert_eq!(dto.code, "easyemail_response_invalid");
        assert!(!dto
            .technical_message
            .as_deref()
            .unwrap_or_default()
            .contains("parser-secret"));
    }

    #[test]
    fn provider_error_message_is_not_exposed_as_user_facing_text() {
        let base_url = serve_once_with_status(
            "400 Bad Request",
            r#"{"message":"Injected UI text\napi_key=provider-secret"}"#,
        );
        let adapter = HttpEasyEmailAdapter::with_timeout_millis(1_000);
        let settings = EasyEmailConnectionSettings {
            service_url: base_url,
            api_token: None,
        };

        let error = adapter
            .health_check(&settings)
            .expect_err("provider request should fail");
        let dto = error.to_dto();

        assert_eq!(dto.user_message, "EasyEmail returned HTTP 400.");
        assert!(!dto.user_message.contains("Injected UI text"));
        assert!(!dto
            .technical_message
            .as_deref()
            .unwrap_or_default()
            .contains("provider-secret"));
    }

    #[test]
    fn http_open_mailbox_maps_canonical_fields() {
        let base_url = serve_once(
            r#"{"result":{"session":{"id":"session_1","hostId":"easyemailam","providerTypeKey":"mailtm","providerInstanceId":"provider_instance_1","emailAddress":"code@example.test","mailboxRef":"mailbox_ref_1","status":"open","createdAt":"2026-06-12T00:00:00Z","expiresAt":"2026-06-12T01:00:00Z","metadata":{}},"instance":{"id":"provider_instance_1","providerTypeKey":"mailtm","displayName":"Mail.tm","status":"active"}}}"#,
        );
        let adapter = HttpEasyEmailAdapter::with_timeout_millis(1_000);
        let settings = EasyEmailConnectionSettings {
            service_url: base_url,
            api_token: None,
        };
        let request = CreateTempMailboxRequest {
            target_service: Some("github".to_string()),
            provider_selection: Some("mailtm".to_string()),
            domain_selection: None,
            local_part: None,
            note: Some("test mailbox".to_string()),
        };

        let mailbox = adapter
            .create_temp_mailbox(&settings, &request)
            .expect("create mailbox");

        assert_eq!(mailbox.email_address, "code@example.test");
        assert_eq!(mailbox.provider_id, "mailtm");
        assert_eq!(mailbox.provider_label, "Mail.tm");
        assert_eq!(mailbox.easyemail_mailbox_id, Some("session_1".to_string()));
    }

    #[test]
    fn http_fetch_temp_messages_queries_session_with_sync() {
        let (base_url, captured) = serve_once_capture(
            r#"{"messages":[{"id":"observed_1","sessionId":"session_1","providerInstanceId":"provider_instance_1","observedAt":"2026-06-12T00:10:00Z","sender":"noreply@example.test","subject":"Your code is 123456","textBody":"Use 123456 to continue."}]}"#,
        );
        let adapter = HttpEasyEmailAdapter::with_timeout_millis(1_000);
        let settings = EasyEmailConnectionSettings {
            service_url: base_url,
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
        let captured_request = captured.lock().expect("captured request").clone();

        assert_eq!(messages.len(), 1);
        assert!(captured_request.starts_with(
            "GET /mail/query/observed-messages?sessionId=session_1&sync=true&newestFirst=true "
        ));
    }
}
