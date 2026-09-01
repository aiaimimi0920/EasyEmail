use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::domain::verification::extract_verification_code;
use crate::easyemail::adapter::EasyEmailAdapter;
use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::services::easyemail_service::{
    refresh_temp_mailbox, TempRefreshMailboxRequest, TempRefreshResult,
};
use crate::storage::verification_repository::{
    get_verification_code_by_id, list_recent_verification_codes, load_message_for_verification,
    persist_verification_code, RecentVerificationCodeFilter, RecentVerificationCodeRow,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationReclassifyRequest {
    pub message_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationListRecentRequest {
    pub temp_mailbox_id: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationPollTempMailboxRequest {
    pub temp_mailbox_id: String,
    pub api_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerificationPollResult {
    pub refresh: TempRefreshResult,
    pub detected_code: Option<RecentVerificationCodeRow>,
}

pub fn classify_new_messages(
    connection: &Connection,
    message_ids: &[String],
    now: &str,
) -> Result<Vec<RecentVerificationCodeRow>, AppError> {
    let transaction = connection.unchecked_transaction().map_err(storage_error)?;
    let mut rows = Vec::new();

    for message_id in message_ids {
        if let Some(row) = classify_message_by_id(&transaction, message_id, now, false)? {
            rows.push(row);
        }
    }
    transaction.commit().map_err(storage_error)?;

    Ok(rows)
}

pub fn reclassify_message(
    connection: &Connection,
    request: VerificationReclassifyRequest,
    now: String,
) -> Result<Option<RecentVerificationCodeRow>, AppError> {
    classify_message_by_id(connection, &request.message_id, &now, true)
}

pub fn list_recent_codes(
    connection: &Connection,
    request: VerificationListRecentRequest,
) -> Result<Vec<RecentVerificationCodeRow>, AppError> {
    list_recent_verification_codes(
        connection,
        RecentVerificationCodeFilter {
            temp_mailbox_id: request.temp_mailbox_id,
            limit: request.limit,
        },
    )
    .map_err(storage_error)
}

pub fn poll_temp_mailbox_for_code<A: EasyEmailAdapter>(
    connection: &Connection,
    adapter: &A,
    request: VerificationPollTempMailboxRequest,
    now: String,
) -> Result<VerificationPollResult, AppError> {
    let previous_code = list_recent_codes(
        connection,
        VerificationListRecentRequest {
            temp_mailbox_id: Some(request.temp_mailbox_id.clone()),
            limit: 1,
        },
    )?
    .into_iter()
    .next()
    .map(|row| (row.id, row.extracted_at));
    let refresh = refresh_temp_mailbox(
        connection,
        adapter,
        TempRefreshMailboxRequest {
            temp_mailbox_id: request.temp_mailbox_id.clone(),
            api_token: request.api_token,
            force: false,
        },
        now,
    )?;
    let detected_code = list_recent_codes(
        connection,
        VerificationListRecentRequest {
            temp_mailbox_id: Some(request.temp_mailbox_id),
            limit: 1,
        },
    )?
    .into_iter()
    .next()
    .filter(|candidate| match previous_code.as_ref() {
        Some((id, extracted_at)) => candidate.id != *id || candidate.extracted_at != *extracted_at,
        None => true,
    });

    Ok(VerificationPollResult {
        refresh,
        detected_code,
    })
}

fn classify_message_by_id(
    connection: &Connection,
    message_id: &str,
    now: &str,
    missing_is_error: bool,
) -> Result<Option<RecentVerificationCodeRow>, AppError> {
    let context = load_message_for_verification(connection, message_id).map_err(storage_error)?;
    let Some(context) = context else {
        if missing_is_error {
            return Err(message_not_found(message_id));
        }
        return Ok(None);
    };

    let Some(code) = extract_verification_code(&context.to_extraction_input(), now) else {
        return Ok(None);
    };
    let code_id = persist_verification_code(connection, &code).map_err(storage_error)?;
    get_verification_code_by_id(connection, &code_id).map_err(storage_error)
}

fn message_not_found(message_id: &str) -> AppError {
    AppError {
        code: "verification_message_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The message selected for verification-code extraction no longer exists."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "message_id": message_id })),
    }
}

fn storage_error(error: rusqlite::Error) -> AppError {
    AppError {
        code: "sqlite_verification_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Verification codes could not be updated in local storage.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};
    use serde_json::json;

    use crate::domain::temp_mailbox::TempMailbox;
    use crate::easyemail::fake::FakeEasyEmailAdapter;
    use crate::easyemail::models::EasyEmailObservedMessage;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;
    use crate::storage::settings_repository::save_easyemail_service_url;
    use crate::storage::temp_mailbox_repository::insert_temp_mailbox;

    use super::*;

    #[test]
    fn reclassify_message_updates_existing_code() {
        let connection = test_connection();
        let message_id = seed_temp_message(
            &connection,
            "temp_1",
            "code@example.test",
            "Code 123456",
            "Use 123456.",
        );

        let first = reclassify_message(
            &connection,
            VerificationReclassifyRequest {
                message_id: message_id.clone(),
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("first reclassify")
        .expect("code extracted");
        let second = reclassify_message(
            &connection,
            VerificationReclassifyRequest { message_id },
            "2026-06-12T00:11:00Z".to_string(),
        )
        .expect("second reclassify")
        .expect("code extracted");

        assert_eq!(first.code, "123456");
        assert_eq!(first.id, second.id);
        assert_eq!(second.extracted_at, "2026-06-12T00:11:00Z");
    }

    #[test]
    fn wait_for_code_polling_reports_detected_code() {
        let connection = test_connection();
        let temp = seed_waiting_temp_mailbox(&connection, "session_wait");
        let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
            "session_wait",
            vec![observed_message_for_service(
                "observed_wait",
                "session_wait",
            )],
        );

        let result = poll_temp_mailbox_for_code(
            &connection,
            &adapter,
            VerificationPollTempMailboxRequest {
                temp_mailbox_id: temp.id,
                api_token: None,
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("poll temp");

        assert!(result.detected_code.is_some());
        assert_eq!(result.refresh.inserted_count, 1);
        assert_eq!(result.detected_code.expect("code").code, "123456");
    }

    #[test]
    fn wait_for_code_polling_does_not_report_an_unchanged_old_code() {
        let connection = test_connection();
        let message_id = seed_temp_message(
            &connection,
            "temp_old",
            "old@example.test",
            "Code 654321",
            "Use 654321.",
        );
        reclassify_message(
            &connection,
            VerificationReclassifyRequest { message_id },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("classify old code")
        .expect("old code exists");
        connection
            .execute(
                "UPDATE temp_mailboxes SET easyemail_mailbox_id = 'session_old' WHERE id = 'temp_old'",
                [],
            )
            .expect("add provider mailbox id");
        let adapter = FakeEasyEmailAdapter::healthy(0);

        let result = poll_temp_mailbox_for_code(
            &connection,
            &adapter,
            VerificationPollTempMailboxRequest {
                temp_mailbox_id: "temp_old".to_string(),
                api_token: None,
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("poll without new mail");

        assert_eq!(result.refresh.inserted_count, 0);
        assert!(result.detected_code.is_none());
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        save_easyemail_service_url(&connection, "http://127.0.0.1:8080", "2026-06-12T00:00:00Z")
            .expect("save EasyEmail URL");
        connection
    }

    fn seed_waiting_temp_mailbox(connection: &Connection, session_id: &str) -> TempMailbox {
        let temp = TempMailbox::from_easyemail(
            "wait@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some(session_id.to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(connection, &temp).expect("insert temp mailbox");
        temp
    }

    fn seed_temp_message(
        connection: &Connection,
        temp_mailbox_id: &str,
        received_address: &str,
        subject: &str,
        body_text: &str,
    ) -> String {
        let source_id = format!("src_{temp_mailbox_id}");
        let message_id = format!("msg_{temp_mailbox_id}");
        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id,
                    source_kind,
                    address,
                    provider_id,
                    status,
                    created_at,
                    updated_at
                ) VALUES (?1, 'easyemail_temp', ?2, 'fake', 'ready', '2026-06-12T00:00:00Z', '2026-06-12T00:00:00Z')",
                params![source_id, received_address],
            )
            .expect("insert source");
        connection
            .execute(
                "INSERT INTO temp_mailboxes (
                    id,
                    email_address,
                    provider_id,
                    provider_label,
                    source_id,
                    visibility_state,
                    lifecycle_state,
                    raw_provider_snapshot_json,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, 'fake', 'Fake Provider', ?3, 'anonymous', 'active', '{}', '2026-06-12T00:00:00Z', '2026-06-12T00:00:00Z')",
                params![temp_mailbox_id, received_address, source_id],
            )
            .expect("insert temp mailbox");
        connection
            .execute(
                "INSERT INTO messages (
                    id,
                    rfc_message_id,
                    subject,
                    from_address,
                    date_received,
                    snippet,
                    body_text_cache,
                    body_cache_state,
                    created_at,
                    updated_at
                ) VALUES (?1, ?1, ?2, 'security@example.test', '2026-06-12T00:10:00Z', ?4, ?4, 'cached', '2026-06-12T00:10:00Z', '2026-06-12T00:10:00Z')",
                params![message_id, subject, temp_mailbox_id, body_text],
            )
            .expect("insert message");
        connection
            .execute(
                "INSERT INTO message_sources (
                    id,
                    message_id,
                    source_id,
                    temp_mailbox_id,
                    provider_message_id,
                    easyemail_message_id,
                    received_address,
                    first_seen_at,
                    last_seen_at
                ) VALUES (?1, ?2, ?3, ?4, ?2, ?2, ?5, '2026-06-12T00:10:00Z', '2026-06-12T00:10:00Z')",
                params![
                    format!("msrc_{temp_mailbox_id}"),
                    message_id,
                    source_id,
                    temp_mailbox_id,
                    received_address
                ],
            )
            .expect("insert message source");

        message_id
    }

    fn observed_message_for_service(id: &str, session_id: &str) -> EasyEmailObservedMessage {
        EasyEmailObservedMessage {
            id: id.to_string(),
            session_id: session_id.to_string(),
            provider_instance_id: "provider_instance_1".to_string(),
            observed_at: "2026-06-12T00:10:00Z".to_string(),
            sender: Some("noreply@example.test".to_string()),
            subject: Some("Your code is 123456".to_string()),
            text_body: Some("Use 123456 to continue.".to_string()),
            html_body: None,
            raw_json: json!({"id": id, "sessionId": session_id}),
        }
    }
}
