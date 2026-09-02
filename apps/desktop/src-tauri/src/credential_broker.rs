use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::secret::windows::WindowsCredentialManagerVault;
use crate::secret::SecretVaultAdapter;

const RESOLVE_PATH: &str = "/v1/credentials/resolve";
const MAX_HEADER_BYTES: usize = 8192;
const MAX_BODY_BYTES: usize = 16_384;
const MAX_CORE_ACCOUNT_RESPONSE_BYTES: usize = 256 * 1024;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialResolveRequest {
    account_id: String,
    credential_ref_id: String,
    secret_backend: String,
    secret_key: String,
    credential_kind: String,
    auth_method: String,
    use_case: String,
}

#[derive(Debug, Deserialize)]
struct CoreAccountResponse {
    account: CoreAccount,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreAccount {
    id: String,
    credential_refs: Vec<CoreCredentialRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreCredentialRef {
    id: String,
    owner_account_id: String,
    secret_backend: String,
    secret_key: String,
    credential_kind: String,
    auth_method: String,
}

#[derive(Debug, Serialize)]
struct ResolvedResponse<'a> {
    status: &'static str,
    secret: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopeDecision {
    Allowed,
    Denied,
    Unavailable,
}

trait CredentialScopeAuthorizer: Send + Sync {
    fn authorize(&self, request: &CredentialResolveRequest) -> ScopeDecision;
}

struct CoreHttpCredentialScopeAuthorizer {
    base_url: String,
    api_token: Zeroizing<String>,
    agent: ureq::Agent,
}

impl CoreHttpCredentialScopeAuthorizer {
    fn new(base_url: &str, api_token: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_token: Zeroizing::new(api_token.to_string()),
            agent: ureq::AgentBuilder::new()
                .timeout(CONNECTION_TIMEOUT)
                .build(),
        }
    }
}

impl CredentialScopeAuthorizer for CoreHttpCredentialScopeAuthorizer {
    fn authorize(&self, request: &CredentialResolveRequest) -> ScopeDecision {
        if !is_safe_identifier(&request.account_id)
            || !is_safe_identifier(&request.credential_ref_id)
        {
            return ScopeDecision::Denied;
        }
        let url = format!("{}/mail/accounts/{}", self.base_url, request.account_id);
        let authorization = Zeroizing::new(format!("Bearer {}", self.api_token.as_str()));
        let response = self
            .agent
            .get(&url)
            .set("Authorization", authorization.as_str())
            .call();
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(404, _)) => return ScopeDecision::Denied,
            Err(_) => return ScopeDecision::Unavailable,
        };
        let payload = match parse_core_account_response(response.into_reader()) {
            Some(payload) => payload,
            None => return ScopeDecision::Unavailable,
        };
        let allowed = payload.account.id == request.account_id
            && payload.account.credential_refs.iter().any(|credential| {
                credential.id == request.credential_ref_id
                    && credential.owner_account_id == request.account_id
                    && credential.secret_backend == request.secret_backend
                    && credential.secret_key == request.secret_key
                    && credential.credential_kind == request.credential_kind
                    && credential.auth_method == request.auth_method
            });
        if allowed {
            ScopeDecision::Allowed
        } else {
            ScopeDecision::Denied
        }
    }
}

fn parse_core_account_response(reader: impl Read) -> Option<CoreAccountResponse> {
    let mut body = Vec::with_capacity(4096);
    let mut bounded_reader = reader.take((MAX_CORE_ACCOUNT_RESPONSE_BYTES + 1) as u64);
    bounded_reader.read_to_end(&mut body).ok()?;
    if body.len() > MAX_CORE_ACCOUNT_RESPONSE_BYTES {
        return None;
    }
    serde_json::from_slice(&body).ok()
}

pub struct DesktopCredentialBroker {
    base_url: String,
    bearer_token: Arc<Zeroizing<String>>,
    shutdown: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl DesktopCredentialBroker {
    pub fn start(core_base_url: &str, core_api_token: &str) -> Result<Self, String> {
        Self::start_with_dependencies(
            Arc::new(WindowsCredentialManagerVault),
            Arc::new(CoreHttpCredentialScopeAuthorizer::new(
                core_base_url,
                core_api_token,
            )),
        )
    }

    fn start_with_dependencies(
        vault: Arc<dyn SecretVaultAdapter>,
        authorizer: Arc<dyn CredentialScopeAuthorizer>,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Could not bind the desktop credential broker: {error}"))?;
        listener.set_nonblocking(true).map_err(|error| {
            format!("Could not configure the desktop credential broker: {error}")
        })?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the desktop credential broker: {error}"))?;
        let base_url = format!("http://127.0.0.1:{}", address.port());
        let bearer_token = Arc::new(Zeroizing::new(format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )));
        let shutdown = Arc::new(AtomicBool::new(false));
        let server_shutdown = Arc::clone(&shutdown);
        let server_token = Arc::clone(&bearer_token);
        let server_thread = thread::Builder::new()
            .name("easyemail-credential-broker".to_string())
            .spawn(move || {
                while !server_shutdown.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            if server_shutdown.load(Ordering::Acquire) {
                                break;
                            }
                            // Windows may inherit the listener's nonblocking mode
                            // on accepted sockets. Restore blocking I/O so the
                            // bounded read/write timeouts govern partial requests.
                            if stream.set_nonblocking(false).is_err() {
                                continue;
                            }
                            handle_connection(
                                &mut stream,
                                server_token.as_str(),
                                vault.as_ref(),
                                authorizer.as_ref(),
                            );
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|error| format!("Could not start the desktop credential broker: {error}"))?;

        Ok(Self {
            base_url,
            bearer_token,
            shutdown,
            thread: Mutex::new(Some(server_thread)),
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn bearer_token(&self) -> &str {
        self.bearer_token.as_str()
    }

    pub fn stop(&self) {
        let server_thread = self
            .thread
            .lock()
            .ok()
            .and_then(|mut server_thread| server_thread.take());
        let Some(server_thread) = server_thread else {
            return;
        };
        self.shutdown.store(true, Ordering::Release);
        if let Ok(address) = self.base_url.trim_start_matches("http://").parse() {
            let _ = TcpStream::connect_timeout(&address, Duration::from_millis(200));
        }
        let _ = server_thread.join();
    }
}

impl Drop for DesktopCredentialBroker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(header: &str) -> Result<usize, ()> {
    let mut content_length = None;
    for line in header.lines().skip(1) {
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(());
            }
            content_length = Some(value.trim().parse::<usize>().map_err(|_| ())?);
        }
    }
    content_length.ok_or(())
}

fn read_request(stream: &mut TcpStream) -> Result<Zeroizing<Vec<u8>>, ()> {
    stream
        .set_read_timeout(Some(CONNECTION_TIMEOUT))
        .map_err(|_| ())?;
    stream
        .set_write_timeout(Some(CONNECTION_TIMEOUT))
        .map_err(|_| ())?;
    let mut buffer = Zeroizing::new(Vec::with_capacity(2048));
    let (header_end, content_length) = loop {
        if let Some(header_end) = find_header_end(&buffer) {
            if header_end > MAX_HEADER_BYTES {
                return Err(());
            }
            let header = std::str::from_utf8(&buffer[..header_end]).map_err(|_| ())?;
            let content_length = parse_content_length(header)?;
            if content_length > MAX_BODY_BYTES {
                return Err(());
            }
            break (header_end, content_length);
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(());
        }
        let mut chunk = [0_u8; 2048];
        let read = stream.read(&mut chunk).map_err(|_| ())?;
        if read == 0 {
            return Err(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let expected_length = header_end + 4 + content_length;
    while buffer.len() < expected_length {
        let mut chunk = [0_u8; 2048];
        let read = stream.read(&mut chunk).map_err(|_| ())?;
        if read == 0 || buffer.len() + read > MAX_HEADER_BYTES + 4 + MAX_BODY_BYTES {
            return Err(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    buffer.truncate(expected_length);
    Ok(buffer)
}

fn handle_connection(
    stream: &mut TcpStream,
    expected_token: &str,
    vault: &dyn SecretVaultAdapter,
    authorizer: &dyn CredentialScopeAuthorizer,
) {
    let buffer = match read_request(stream) {
        Ok(buffer) => buffer,
        Err(()) => {
            write_error(stream, 400, "invalid_request");
            return;
        }
    };
    let Some(header_end) = find_header_end(&buffer) else {
        write_error(stream, 400, "invalid_request");
        return;
    };
    let header = match std::str::from_utf8(&buffer[..header_end]) {
        Ok(header) => header,
        Err(_) => {
            write_error(stream, 400, "invalid_request");
            return;
        }
    };
    let mut lines = header.lines();
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default();
    let path = request_line.next().unwrap_or_default();
    let version = request_line.next().unwrap_or_default();
    if request_line.next().is_some() || version != "HTTP/1.1" {
        write_error(stream, 400, "invalid_request");
        return;
    }
    let authorization = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then_some(value.trim())
    });
    let expected_authorization = Zeroizing::new(format!("Bearer {expected_token}"));
    if !authorization
        .map(|value| constant_time_equal(value, expected_authorization.as_str()))
        .unwrap_or(false)
    {
        write_error(stream, 401, "unauthorized");
        return;
    }
    if method != "POST" || path != RESOLVE_PATH {
        write_error(stream, 404, "not_found");
        return;
    }
    let request =
        match serde_json::from_slice::<CredentialResolveRequest>(&buffer[header_end + 4..]) {
            Ok(request) => request,
            Err(_) => {
                write_error(stream, 400, "invalid_request");
                return;
            }
        };
    if request.use_case != "imap-test"
        || request.credential_kind != "imap_password"
        || request.auth_method != "password"
        || !matches!(
            request.secret_backend.as_str(),
            "windows_credential_manager" | "secret_vault"
        )
        || !(request.secret_key.starts_with("ref:v1:")
            || request.secret_key.starts_with("secret://imap/"))
    {
        write_error(stream, 403, "scope_denied");
        return;
    }
    match authorizer.authorize(&request) {
        ScopeDecision::Denied => {
            write_error(stream, 403, "scope_denied");
            return;
        }
        ScopeDecision::Unavailable => {
            write_error(stream, 503, "scope_unavailable");
            return;
        }
        ScopeDecision::Allowed => {}
    }

    let mut secret = match vault.load_secret(&request.secret_key) {
        Ok(Some(secret)) if !secret.is_empty() => secret,
        Ok(_) => {
            write_error(stream, 404, "credential_missing");
            return;
        }
        Err(_) => {
            write_error(stream, 503, "credential_unavailable");
            return;
        }
    };
    let mut body = match serde_json::to_vec(&ResolvedResponse {
        status: "resolved",
        secret: &secret,
    }) {
        Ok(body) => body,
        Err(_) => {
            secret.zeroize();
            write_error(stream, 503, "credential_unavailable");
            return;
        }
    };
    write_json(stream, 200, &body);
    body.zeroize();
    secret.zeroize();
}

fn write_error(stream: &mut TcpStream, status: u16, code: &str) {
    let body = format!(r#"{{"status":"error","code":"{code}"}}"#);
    write_json(stream, status, body.as_bytes());
}

fn write_json(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Service Unavailable",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::fake::FakeSecretVaultAdapter;

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
        let body = serde_json::to_vec(&request_body()).unwrap();
        let address = broker.base_url().trim_start_matches("http://");
        let mut stream = TcpStream::connect(address).unwrap();
        let authorization = bearer_token
            .map(|token| format!("Authorization: Bearer {token}\r\n"))
            .unwrap_or_default();
        write!(
            stream,
            "POST {RESOLVE_PATH} HTTP/1.1\r\nHost: {address}\r\n{authorization}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
}
