use lettre::message::{header::ContentType, Mailbox};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::smtp::adapter::SmtpAdapter;
use crate::smtp::models::{
    SmtpConnectionProfile, SmtpConnectionTestResult, SmtpSendMessage, SmtpSendResult,
};

#[derive(Debug, Clone, Default)]
pub struct NativeSmtpAdapter;

impl SmtpAdapter for NativeSmtpAdapter {
    fn test_connection(
        &self,
        profile: &SmtpConnectionProfile,
        secret: &str,
    ) -> Result<SmtpConnectionTestResult, AppError> {
        let mailer = build_transport(profile, secret)?;
        let authenticated = mailer
            .test_connection()
            .map_err(|error| smtp_error("smtp_connection_test_failed", error))?;

        Ok(SmtpConnectionTestResult {
            authenticated,
            capability_summary: if authenticated {
                format!(
                    "{}:{} {} authenticated",
                    profile.host, profile.port, profile.security
                )
            } else {
                format!(
                    "{}:{} reachable but not authenticated",
                    profile.host, profile.port
                )
            },
        })
    }

    fn send_message(
        &self,
        profile: &SmtpConnectionProfile,
        secret: &str,
        message: &SmtpSendMessage,
    ) -> Result<SmtpSendResult, AppError> {
        let mailer = build_transport(profile, secret)?;
        let mut builder = Message::builder()
            .from(parse_mailbox(&message.from_address, "from")?)
            .subject(message.subject.trim());
        for to_address in &message.to_addresses {
            builder = builder.to(parse_mailbox(to_address, "to")?);
        }
        for cc_address in &message.cc_addresses {
            builder = builder.cc(parse_mailbox(cc_address, "cc")?);
        }
        for bcc_address in &message.bcc_addresses {
            builder = builder.bcc(parse_mailbox(bcc_address, "bcc")?);
        }
        let email = builder
            .header(ContentType::TEXT_PLAIN)
            .body(message.body_text.clone())
            .map_err(|error| {
                smtp_validation_error(
                    "smtp_message_build_failed",
                    "The queued email could not be converted into an SMTP message.",
                    Some(error.to_string()),
                )
            })?;

        let response = mailer
            .send(&email)
            .map_err(|error| smtp_error("smtp_send_failed", error))?;

        let response_message = response.message().collect::<Vec<_>>().join(" ");
        Ok(SmtpSendResult {
            provider_message_id: Some(response_message).filter(|value| !value.is_empty()),
        })
    }
}

fn build_transport(
    profile: &SmtpConnectionProfile,
    secret: &str,
) -> Result<SmtpTransport, AppError> {
    let credentials = Credentials::new(profile.username.clone(), secret.to_string());
    let host = profile.host.trim();
    let security = profile.security.trim().to_ascii_lowercase();

    let builder = match security.as_str() {
        "tls" => SmtpTransport::relay(host)
            .map_err(|error| smtp_error("smtp_transport_build_failed", error))?,
        "starttls" => SmtpTransport::starttls_relay(host)
            .map_err(|error| smtp_error("smtp_transport_build_failed", error))?,
        "" if profile.port == 465 => SmtpTransport::relay(host)
            .map_err(|error| smtp_error("smtp_transport_build_failed", error))?,
        "" if profile.port == 587 => SmtpTransport::starttls_relay(host)
            .map_err(|error| smtp_error("smtp_transport_build_failed", error))?,
        _ => {
            return Err(smtp_validation_error(
                "smtp_security_unsupported",
                "SMTP security must use TLS or STARTTLS before credentials can be sent.",
                Some(format!(
                    "unsupported security mode '{}' on port {}",
                    profile.security, profile.port
                )),
            ));
        }
    };

    Ok(builder.port(profile.port).credentials(credentials).build())
}

fn parse_mailbox(value: &str, field: &str) -> Result<Mailbox, AppError> {
    let trimmed = value.trim();
    let fallback = extract_angle_address(trimmed).unwrap_or(trimmed);

    trimmed
        .parse::<Mailbox>()
        .or_else(|_| fallback.parse::<Mailbox>())
        .map_err(|error| {
            smtp_validation_error(
                "smtp_address_invalid",
                &format!("The {field} address is not a valid email address."),
                Some(error.to_string()),
            )
        })
}

fn extract_angle_address(value: &str) -> Option<&str> {
    let start = value.find('<')?;
    let end = value[start + 1..].find('>')? + start + 1;
    Some(value[start + 1..end].trim())
}

fn smtp_error(code: &str, error: lettre::transport::smtp::Error) -> AppError {
    let technical_message = error.to_string();
    let lower = technical_message.to_ascii_lowercase();
    let auth_error = lower.contains("auth")
        || lower.contains("credential")
        || lower.contains("535")
        || lower.contains("password");

    AppError {
        code: if auth_error {
            "smtp_auth_failed".to_string()
        } else {
            code.to_string()
        },
        category: if auth_error {
            ErrorCategory::Auth
        } else {
            ErrorCategory::Provider
        },
        user_message: if auth_error {
            "The SMTP server rejected the supplied credentials.".to_string()
        } else {
            "The SMTP server could not complete the requested operation.".to_string()
        },
        technical_message: Some(technical_message),
        retryable: !auth_error,
        action_required: if auth_error {
            ActionRequired::EditSettings
        } else {
            ActionRequired::Retry
        },
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "native_smtp" })),
    }
}

fn smtp_validation_error(
    code: &str,
    user_message: &str,
    technical_message: Option<String>,
) -> AppError {
    AppError {
        code: code.to_string(),
        category: ErrorCategory::Validation,
        user_message: user_message.to_string(),
        technical_message,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "native_smtp" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_smtp_extracts_angle_address() {
        assert_eq!(
            extract_angle_address("Acme Cloud <noreply@example.test>"),
            Some("noreply@example.test")
        );
    }

    #[test]
    fn native_smtp_uses_qq_tls_port_as_wrapped_tls() {
        let profile = SmtpConnectionProfile {
            host: "smtp.qq.com".to_string(),
            port: 465,
            security: "tls".to_string(),
            username: "user@qq.com".to_string(),
        };

        let mailer = build_transport(&profile, "authorization-code");
        assert!(mailer.is_ok());
    }

    #[test]
    fn native_smtp_rejects_unsupported_security_instead_of_sending_plaintext() {
        let profile = SmtpConnectionProfile {
            host: "smtp.example.test".to_string(),
            port: 25,
            security: "plain".to_string(),
            username: "user@example.test".to_string(),
        };

        let error = build_transport(&profile, "password").expect_err("plaintext rejected");

        assert_eq!(error.code, "smtp_security_unsupported");
        assert_eq!(error.category, ErrorCategory::Validation);
        assert!(!error.retryable);
    }
}
