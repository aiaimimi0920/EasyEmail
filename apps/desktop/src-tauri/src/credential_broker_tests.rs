use super::*;
use crate::secret::fake::FakeSecretVaultAdapter;
use std::time::Instant;

struct FixedAuthorizer(ScopeDecision);

impl CredentialScopeAuthorizer for FixedAuthorizer {
    fn authorize(&self, _request: &CredentialResolveRequest) -> ScopeDecision {
        self.0
    }
}

fn request_body() -> serde_json::Value {
    serde_json::json!({
        "accountId": "acct_v1_test",
        "credentialRefId": "cred_v1_test",
        "secretBackend": "windows_credential_manager",
        "secretKey": "ref:v1:desktop/00000000000000000000000000000001",
        "credentialKind": "imap_password",
        "authMethod": "password",
        "useCase": "imap-test"
    })
}

fn post_broker(
    broker: &DesktopCredentialBroker,
    bearer_token: Option<&str>,
) -> (u16, serde_json::Value) {
    let authorization = bearer_token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    post_broker_with_authorization_headers(broker, &authorization)
}

fn post_broker_with_authorization_headers(
    broker: &DesktopCredentialBroker,
    authorization_headers: &str,
) -> (u16, serde_json::Value) {
    let body = serde_json::to_vec(&request_body()).unwrap();
    let address = broker.base_url().trim_start_matches("http://");
    let mut stream = TcpStream::connect(address).unwrap();
    write!(
        stream,
        "POST {RESOLVE_PATH} HTTP/1.1\r\nHost: {address}\r\n{authorization_headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.write_all(&body).unwrap();
    stream.flush().unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    let response = String::from_utf8(response).unwrap();
    let (header, body) = response.split_once("\r\n\r\n").unwrap();
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap();
    (status, serde_json::from_str(body).unwrap())
}

#[test]
fn broker_authenticates_scope_checks_and_resolves_without_listing() {
    let vault = Arc::new(FakeSecretVaultAdapter::default());
    let body = request_body();
    let key = body["secretKey"].as_str().unwrap();
    vault.save_secret(key, "broker-secret-canary").unwrap();
    let broker = DesktopCredentialBroker::start_with_dependencies(
        vault,
        Arc::new(FixedAuthorizer(ScopeDecision::Allowed)),
    )
    .unwrap();
    let (unauthorized_status, _) = post_broker(&broker, None);
    assert_eq!(unauthorized_status, 401);

    let (status, response) = post_broker(&broker, Some(broker.bearer_token()));
    assert_eq!(status, 200);
    assert_eq!(response["status"], "resolved");
    assert_eq!(response["secret"], "broker-secret-canary");
    broker.stop();
    broker.stop();
}

#[test]
fn slow_client_does_not_block_an_authenticated_resolution() {
    let vault = Arc::new(FakeSecretVaultAdapter::default());
    let key = request_body()["secretKey"].as_str().unwrap().to_string();
    vault
        .save_secret(&key, "broker-concurrency-canary")
        .unwrap();
    let broker = DesktopCredentialBroker::start_with_dependencies(
        vault,
        Arc::new(FixedAuthorizer(ScopeDecision::Allowed)),
    )
    .unwrap();
    let address = broker.base_url().trim_start_matches("http://");
    let mut slow_client = TcpStream::connect(address).unwrap();
    write!(
        slow_client,
        "POST {RESOLVE_PATH} HTTP/1.1\r\nHost: {address}\r\n"
    )
    .unwrap();
    slow_client.flush().unwrap();
    thread::sleep(Duration::from_millis(100));

    let started = Instant::now();
    let (status, response) = post_broker(&broker, Some(broker.bearer_token()));

    assert_eq!(status, 200);
    assert_eq!(response["secret"], "broker-concurrency-canary");
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(slow_client);
    broker.stop();
}

#[test]
fn broker_rejects_duplicate_authorization_headers() {
    let vault = Arc::new(FakeSecretVaultAdapter::default());
    let key = request_body()["secretKey"].as_str().unwrap().to_string();
    vault.save_secret(&key, "broker-secret-canary").unwrap();
    let broker = DesktopCredentialBroker::start_with_dependencies(
        vault,
        Arc::new(FixedAuthorizer(ScopeDecision::Allowed)),
    )
    .unwrap();
    let lowercase_header = format!(
        "X-Test-Header: before-authorization\r\nauthorization: Bearer {}\r\n",
        broker.bearer_token()
    );
    let (status, response) = post_broker_with_authorization_headers(&broker, &lowercase_header);
    assert_eq!(status, 200);
    assert_eq!(response["secret"], "broker-secret-canary");

    for headers in [
        format!(
            "Authorization: Bearer {}\r\nauthorization: Bearer attacker\r\n",
            broker.bearer_token()
        ),
        format!(
            "Authorization: Bearer attacker\r\nauthorization: Bearer {}\r\n",
            broker.bearer_token()
        ),
    ] {
        let (status, response) = post_broker_with_authorization_headers(&broker, &headers);
        assert_eq!(status, 400);
        assert_eq!(response["code"], "invalid_request");
    }
    broker.stop();
}

#[test]
fn broker_rejects_cross_scope_and_reports_missing_credentials() {
    let denied = DesktopCredentialBroker::start_with_dependencies(
        Arc::new(FakeSecretVaultAdapter::default()),
        Arc::new(FixedAuthorizer(ScopeDecision::Denied)),
    )
    .unwrap();
    let (denied_status, _) = post_broker(&denied, Some(denied.bearer_token()));
    assert_eq!(denied_status, 403);
    denied.stop();

    let missing = DesktopCredentialBroker::start_with_dependencies(
        Arc::new(FakeSecretVaultAdapter::default()),
        Arc::new(FixedAuthorizer(ScopeDecision::Allowed)),
    )
    .unwrap();
    let (missing_status, _) = post_broker(&missing, Some(missing.bearer_token()));
    assert_eq!(missing_status, 404);
    missing.stop();
}

#[test]
fn broker_resolves_the_same_opaque_ref_after_restart() {
    let vault = Arc::new(FakeSecretVaultAdapter::default());
    let key = request_body()["secretKey"].as_str().unwrap().to_string();
    vault.save_secret(&key, "broker-restart-canary").unwrap();

    let first = DesktopCredentialBroker::start_with_dependencies(
        vault.clone(),
        Arc::new(FixedAuthorizer(ScopeDecision::Allowed)),
    )
    .unwrap();
    let (first_status, first_response) = post_broker(&first, Some(first.bearer_token()));
    first.stop();

    let restarted = DesktopCredentialBroker::start_with_dependencies(
        vault,
        Arc::new(FixedAuthorizer(ScopeDecision::Allowed)),
    )
    .unwrap();
    let (restarted_status, restarted_response) =
        post_broker(&restarted, Some(restarted.bearer_token()));
    restarted.stop();

    assert_eq!(first_status, 200);
    assert_eq!(restarted_status, 200);
    assert_eq!(first_response["status"], "resolved");
    assert_eq!(restarted_response["status"], "resolved");
    assert_eq!(first_response["secret"], restarted_response["secret"]);
}

#[test]
fn parser_rejects_ambiguous_http_message_lengths() {
    assert_eq!(
        parse_content_length("POST / HTTP/1.1\r\nContent-Length: 12\r\n").unwrap(),
        12
    );
    assert!(parse_content_length(
        "POST / HTTP/1.1\r\nContent-Length: 12\r\nContent-Length: 12\r\n"
    )
    .is_err());
    assert!(parse_content_length(
        "POST / HTTP/1.1\r\nContent-Length: 12\r\nTransfer-Encoding: chunked\r\n"
    )
    .is_err());
}

#[test]
fn core_account_response_parser_rejects_oversized_payloads() {
    let oversized = vec![b' '; MAX_CORE_ACCOUNT_RESPONSE_BYTES + 1];
    assert!(parse_core_account_response(std::io::Cursor::new(oversized)).is_none());

    let valid = br#"{"account":{"id":"acct_v1_test","credentialRefs":[]}}"#;
    let parsed = parse_core_account_response(std::io::Cursor::new(valid)).unwrap();
    assert_eq!(parsed.account.id, "acct_v1_test");
}
