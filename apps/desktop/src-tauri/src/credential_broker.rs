use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::secret::windows::WindowsCredentialManagerVault;
use crate::secret::SecretVaultAdapter;

#[path = "credential_broker_http.rs"]
mod http;
#[path = "credential_broker_workers.rs"]
mod workers;

use http::{constant_time_equal, read_broker_http_request, write_error, write_json};

const RESOLVE_PATH: &str = "/v1/credentials/resolve";
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
                workers::run_bounded_server(listener, server_shutdown, move |mut stream| {
                    // Windows may inherit the listener's nonblocking mode.
                    if stream.set_nonblocking(false).is_err() {
                        return;
                    }
                    handle_connection(
                        &mut stream,
                        server_token.as_str(),
                        vault.as_ref(),
                        authorizer.as_ref(),
                    );
                });
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

fn is_supported_credential_scope(request: &CredentialResolveRequest) -> bool {
    if request.auth_method != "password"
        || !matches!(
            request.secret_backend.as_str(),
            "windows_credential_manager" | "secret_vault"
        )
    {
        return false;
    }
    match (request.use_case.as_str(), request.credential_kind.as_str()) {
        ("imap-test", "imap_password") => {
            request.secret_key.starts_with("ref:v1:")
                || request.secret_key.starts_with("secret://imap/")
        }
        ("smtp-test" | "smtp-send", "smtp_password") => {
            request.secret_key.starts_with("ref:v1:")
                || request.secret_key.starts_with("secret://smtp/")
        }
        _ => false,
    }
}

fn handle_connection(
    stream: &mut TcpStream,
    expected_token: &str,
    vault: &dyn SecretVaultAdapter,
    authorizer: &dyn CredentialScopeAuthorizer,
) {
    let parsed = match read_broker_http_request(stream, CONNECTION_TIMEOUT) {
        Ok(parsed) => parsed,
        Err(()) => {
            write_error(stream, 400, "invalid_request");
            return;
        }
    };
    let expected_authorization = Zeroizing::new(format!("Bearer {expected_token}"));
    if !parsed
        .authorization
        .as_deref()
        .map(|value| constant_time_equal(value, expected_authorization.as_str()))
        .unwrap_or(false)
    {
        write_error(stream, 401, "unauthorized");
        return;
    }
    if parsed.method != "POST" || parsed.path != RESOLVE_PATH {
        write_error(stream, 404, "not_found");
        return;
    }
    let request = match serde_json::from_slice::<CredentialResolveRequest>(
        &parsed.buffer[parsed.body_offset..],
    ) {
        Ok(request) => request,
        Err(_) => {
            write_error(stream, 400, "invalid_request");
            return;
        }
    };
    if !is_supported_credential_scope(&request) {
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

#[cfg(test)]
#[path = "credential_broker_tests.rs"]
mod tests;
