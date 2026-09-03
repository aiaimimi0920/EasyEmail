use imap::{ConnectionMode, Session};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::imap::models::ImapConnectionProfile;

pub(super) fn connect_session(
    profile: &ImapConnectionProfile,
    secret: &str,
) -> Result<Session<imap::Connection>, AppError> {
    let mode = match profile.security.trim().to_ascii_lowercase().as_str() {
        "tls" | "ssl" => ConnectionMode::Tls,
        "starttls" => ConnectionMode::StartTls,
        "" if profile.port == 993 => ConnectionMode::Tls,
        "" if profile.port == 143 => ConnectionMode::StartTls,
        _ => return Err(imap_security_unsupported(profile)),
    };
    let client = imap::ClientBuilder::new(profile.host.trim(), profile.port)
        .mode(mode)
        .connect()
        .map_err(|error| imap_error("imap_connect_failed", error))?;

    client
        .login(profile.username.trim(), secret)
        .map_err(|(error, _)| imap_error("imap_login_failed", error))
}

fn imap_security_unsupported(profile: &ImapConnectionProfile) -> AppError {
    AppError {
        code: "imap_security_unsupported".to_string(),
        category: ErrorCategory::Validation,
        user_message: "IMAP security must use TLS or STARTTLS before credentials can be sent."
            .to_string(),
        technical_message: Some(format!(
            "unsupported security mode '{}' on port {}",
            profile.security, profile.port
        )),
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "native_imap" })),
    }
}

pub(super) fn logout_quietly(mut session: Session<imap::Connection>) {
    let _ = session.logout();
}

pub(super) fn imap_error(code: &str, error: imap::Error) -> AppError {
    let technical_message = error.to_string();
    let lower = technical_message.to_ascii_lowercase();
    let auth_error = lower.contains("auth")
        || lower.contains("login")
        || lower.contains("credential")
        || lower.contains("password")
        || lower.contains("authenticationfailed");

    AppError {
        code: if auth_error {
            "imap_auth_failed".to_string()
        } else {
            code.to_string()
        },
        category: if auth_error {
            ErrorCategory::Auth
        } else {
            ErrorCategory::Provider
        },
        user_message: if auth_error {
            "The IMAP server rejected the supplied credentials.".to_string()
        } else {
            "The IMAP server could not complete the requested operation.".to_string()
        },
        technical_message: Some(technical_message),
        retryable: !auth_error,
        action_required: if auth_error {
            ActionRequired::EditSettings
        } else {
            ActionRequired::Retry
        },
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "native_imap" })),
    }
}
