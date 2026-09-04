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
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
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
