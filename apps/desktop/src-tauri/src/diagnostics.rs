use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::redaction::{redact_json, redact_text};

const REDACTED_BODY: &str = "[REDACTED_BODY]";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewDiagnosticLogEntry {
    pub level: DiagnosticLogLevel,
    pub target: String,
    pub message: String,
    pub metadata: Value,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticLogEntry {
    pub level: DiagnosticLogLevel,
    pub target: String,
    pub message: String,
    pub metadata: Value,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticExport {
    pub logs: Vec<DiagnosticLogEntry>,
}

#[derive(Debug, Default)]
pub struct DiagnosticLogger {
    logs: Mutex<Vec<DiagnosticLogEntry>>,
}

impl DiagnosticLogger {
    pub fn log(&self, entry: NewDiagnosticLogEntry) {
        self.logs
            .lock()
            .expect("diagnostic logger lock is not poisoned")
            .push(DiagnosticLogEntry {
                level: entry.level,
                target: entry.target,
                message: redact_text(&entry.message),
                metadata: redact_diagnostic_metadata(&entry.metadata),
                occurred_at: entry.occurred_at,
            });
    }

    pub fn export_default(&self) -> DiagnosticExport {
        DiagnosticExport {
            logs: self
                .logs
                .lock()
                .expect("diagnostic logger lock is not poisoned")
                .clone(),
        }
    }
}

fn redact_diagnostic_metadata(value: &Value) -> Value {
    redact_json(&redact_message_body_fields(value))
}

fn redact_message_body_fields(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = Map::new();
            for (key, nested) in object {
                if is_message_body_key(key) {
                    redacted.insert(key.clone(), Value::String(REDACTED_BODY.to_string()));
                } else {
                    redacted.insert(key.clone(), redact_message_body_fields(nested));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(redact_message_body_fields).collect())
        }
        _ => value.clone(),
    }
}

fn is_message_body_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "message_body" | "body_text" | "body_html" | "body_text_cache" | "body_html_cache"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_redact_password_fields() {
        let logger = DiagnosticLogger::default();

        logger.log(NewDiagnosticLogEntry {
            level: DiagnosticLogLevel::Warn,
            target: "imap".to_string(),
            message: "password=plain-secret failed".to_string(),
            metadata: serde_json::json!({
                "account_id": "acct_1",
                "password": "plain-secret",
            }),
            occurred_at: "2026-06-12T04:05:00Z".to_string(),
        });

        let export = logger.export_default();
        let serialized = serde_json::to_string(&export).expect("serialize export");

        assert!(!serialized.contains("plain-secret"));
        assert!(serialized.contains("password=[REDACTED]"));
        assert_eq!(export.logs[0].metadata["password"], "[REDACTED]");
    }

    #[test]
    fn logs_redact_oauth_tokens() {
        let logger = DiagnosticLogger::default();

        logger.log(NewDiagnosticLogEntry {
            level: DiagnosticLogLevel::Error,
            target: "oauth".to_string(),
            message: "access_token=abc refresh_token=def".to_string(),
            metadata: serde_json::json!({
                "access_token": "abc",
                "refresh_token": "def",
            }),
            occurred_at: "2026-06-12T04:06:00Z".to_string(),
        });

        let export = logger.export_default();
        let serialized = serde_json::to_string(&export).expect("serialize export");

        assert!(!serialized.contains("abc"));
        assert!(!serialized.contains("def"));
        assert_eq!(export.logs[0].metadata["access_token"], "[REDACTED]");
        assert_eq!(export.logs[0].metadata["refresh_token"], "[REDACTED]");
    }

    #[test]
    fn diagnostic_export_excludes_message_body_by_default() {
        let logger = DiagnosticLogger::default();

        logger.log(NewDiagnosticLogEntry {
            level: DiagnosticLogLevel::Info,
            target: "message_fetch".to_string(),
            message: "stored message metadata".to_string(),
            metadata: serde_json::json!({
                "message_id": "msg_1",
                "body_text": "full private body",
                "nested": {
                    "body_html": "<p>full private body</p>"
                }
            }),
            occurred_at: "2026-06-12T04:07:00Z".to_string(),
        });

        let export = logger.export_default();
        let serialized = serde_json::to_string(&export).expect("serialize export");

        assert!(!serialized.contains("full private body"));
        assert_eq!(export.logs[0].metadata["body_text"], "[REDACTED_BODY]");
        assert_eq!(
            export.logs[0].metadata["nested"]["body_html"],
            "[REDACTED_BODY]"
        );
    }
}
