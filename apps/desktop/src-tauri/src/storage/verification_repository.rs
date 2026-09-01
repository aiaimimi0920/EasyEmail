use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::verification::{VerificationCode, VerificationExtractionInput};

#[derive(Debug, Clone, PartialEq)]
pub struct MessageVerificationContext {
    pub message_id: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub received_address: String,
    pub account_scope: String,
    pub temp_mailbox_id: Option<String>,
    pub source_id: String,
    pub observed_at: String,
    pub target_service_hint: Option<String>,
}

impl MessageVerificationContext {
    pub fn to_extraction_input(&self) -> VerificationExtractionInput {
        VerificationExtractionInput {
            message_id: self.message_id.clone(),
            account_scope: self.account_scope.clone(),
            received_address: self.received_address.clone(),
            subject: self.subject.clone(),
            from_address: self.from_address.clone(),
            snippet: self.snippet.clone(),
            body_text: self.body_text.clone(),
            body_html: self.body_html.clone(),
            target_service_hint: self.target_service_hint.clone(),
            observed_at: self.observed_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecentVerificationCodeFilter {
    pub temp_mailbox_id: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentVerificationCodeRow {
    pub id: String,
    pub message_id: String,
    pub temp_mailbox_id: Option<String>,
    pub source_id: String,
    pub account_scope: String,
    pub received_address: String,
    pub code: String,
    pub issuer_hint: Option<String>,
    pub target_service_hint: Option<String>,
    pub confidence: f64,
    pub expires_at: Option<String>,
    pub extracted_at: String,
    pub subject: String,
    pub from_address: String,
    pub observed_at: String,
}

pub fn load_message_for_verification(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<MessageVerificationContext>> {
    connection
        .query_row(
            "SELECT
                messages.id AS message_id,
                messages.subject AS subject,
                messages.from_address AS from_address,
                messages.snippet AS snippet,
                messages.body_text_cache AS body_text,
                messages.body_html_cache AS body_html,
                COALESCE(
                    message_sources.received_address,
                    temp_mailboxes.email_address,
                    mailbox_sources.address,
                    ''
                ) AS received_address,
                CASE
                    WHEN message_sources.temp_mailbox_id IS NOT NULL THEN 'anonymous'
                    WHEN accounts.scope IS NOT NULL THEN accounts.scope
                    ELSE 'normal'
                END AS account_scope,
                message_sources.temp_mailbox_id AS temp_mailbox_id,
                message_sources.source_id AS source_id,
                COALESCE(
                    messages.date_received,
                    message_sources.first_seen_at,
                    messages.created_at
                ) AS observed_at
             FROM messages
             INNER JOIN message_sources ON message_sources.message_id = messages.id
             LEFT JOIN temp_mailboxes ON temp_mailboxes.id = message_sources.temp_mailbox_id
             LEFT JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             LEFT JOIN accounts ON accounts.id = message_sources.account_id
             WHERE messages.id = ?1
               AND messages.deleted_at IS NULL
             ORDER BY message_sources.first_seen_at DESC, message_sources.id DESC
             LIMIT 1",
            params![message_id],
            |row| {
                Ok(MessageVerificationContext {
                    message_id: row.get("message_id")?,
                    subject: row.get("subject")?,
                    from_address: row.get("from_address")?,
                    snippet: row.get("snippet")?,
                    body_text: row.get("body_text")?,
                    body_html: row.get("body_html")?,
                    received_address: row.get("received_address")?,
                    account_scope: row.get("account_scope")?,
                    temp_mailbox_id: row.get("temp_mailbox_id")?,
                    source_id: row.get("source_id")?,
                    observed_at: row.get("observed_at")?,
                    target_service_hint: None,
                })
            },
        )
        .optional()
}

pub fn persist_verification_code(
    connection: &Connection,
    code: &VerificationCode,
) -> Result<String> {
    let existing_id: Option<String> = connection
        .query_row(
            "SELECT id
             FROM verification_codes
             WHERE message_id = ?1
               AND code = ?2
             LIMIT 1",
            params![&code.message_id, &code.code],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(existing_id) = existing_id {
        connection.execute(
            "UPDATE verification_codes
             SET account_scope = ?1,
                 received_address = ?2,
                 issuer_hint = ?3,
                 target_service_hint = ?4,
                 confidence = ?5,
                 expires_at = ?6,
                 extracted_at = ?7
             WHERE id = ?8",
            params![
                &code.account_scope,
                &code.received_address,
                &code.issuer_hint,
                &code.target_service_hint,
                code.confidence,
                &code.expires_at,
                &code.extracted_at,
                &existing_id,
            ],
        )?;
        return Ok(existing_id);
    }

    let id = if code.id.trim().is_empty() {
        format!("vcode_{}", Uuid::new_v4())
    } else {
        code.id.clone()
    };
    connection.execute(
        "INSERT INTO verification_codes (
            id,
            message_id,
            account_scope,
            received_address,
            code,
            issuer_hint,
            target_service_hint,
            confidence,
            expires_at,
            extracted_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            &code.message_id,
            &code.account_scope,
            &code.received_address,
            &code.code,
            &code.issuer_hint,
            &code.target_service_hint,
            code.confidence,
            &code.expires_at,
            &code.extracted_at,
        ],
    )?;

    Ok(id)
}

pub fn list_recent_verification_codes(
    connection: &Connection,
    filter: RecentVerificationCodeFilter,
) -> Result<Vec<RecentVerificationCodeRow>> {
    let limit = clamp_limit(filter.limit);
    if let Some(temp_mailbox_id) = filter.temp_mailbox_id {
        let mut statement = connection.prepare(&recent_codes_sql(
            "WHERE message_sources.temp_mailbox_id = ?1",
        ))?;
        return rows_from_statement(&mut statement, params![temp_mailbox_id, limit]);
    }

    let mut statement = connection.prepare(&recent_codes_sql(""))?;
    rows_from_statement(&mut statement, params![limit])
}

pub fn get_verification_code_by_id(
    connection: &Connection,
    id: &str,
) -> Result<Option<RecentVerificationCodeRow>> {
    let mut statement =
        connection.prepare(&recent_codes_sql("WHERE verification_codes.id = ?1"))?;
    Ok(rows_from_statement(&mut statement, params![id, 1])?
        .into_iter()
        .next())
}

fn recent_codes_sql(where_clause: &str) -> String {
    let limit_parameter = if where_clause.is_empty() { "?1" } else { "?2" };
    format!(
        "SELECT
            verification_codes.id AS id,
            verification_codes.message_id AS message_id,
            message_sources.temp_mailbox_id AS temp_mailbox_id,
            message_sources.source_id AS source_id,
            verification_codes.account_scope AS account_scope,
            verification_codes.received_address AS received_address,
            verification_codes.code AS code,
            verification_codes.issuer_hint AS issuer_hint,
            verification_codes.target_service_hint AS target_service_hint,
            verification_codes.confidence AS confidence,
            verification_codes.expires_at AS expires_at,
            verification_codes.extracted_at AS extracted_at,
            messages.subject AS subject,
            messages.from_address AS from_address,
            COALESCE(
                messages.date_received,
                message_sources.first_seen_at,
                messages.created_at
            ) AS observed_at
         FROM verification_codes
         INNER JOIN messages ON messages.id = verification_codes.message_id
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         {where_clause}
         ORDER BY verification_codes.extracted_at DESC, verification_codes.id DESC
         LIMIT {limit_parameter}"
    )
}

fn rows_from_statement<P>(
    statement: &mut rusqlite::Statement<'_>,
    params: P,
) -> Result<Vec<RecentVerificationCodeRow>>
where
    P: rusqlite::Params,
{
    statement
        .query_map(params, |row| {
            Ok(RecentVerificationCodeRow {
                id: row.get("id")?,
                message_id: row.get("message_id")?,
                temp_mailbox_id: row.get("temp_mailbox_id")?,
                source_id: row.get("source_id")?,
                account_scope: row.get("account_scope")?,
                received_address: row.get("received_address")?,
                code: row.get("code")?,
                issuer_hint: row.get("issuer_hint")?,
                target_service_hint: row.get("target_service_hint")?,
                confidence: row.get("confidence")?,
                expires_at: row.get("expires_at")?,
                extracted_at: row.get("extracted_at")?,
                subject: row.get("subject")?,
                from_address: row.get("from_address")?,
                observed_at: row.get("observed_at")?,
            })
        })?
        .collect::<Result<Vec<_>>>()
}

fn clamp_limit(limit: usize) -> i64 {
    if limit == 0 {
        25
    } else {
        limit.min(100) as i64
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};

    use crate::domain::verification::extract_verification_code;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    use super::*;

    #[test]
    fn associates_code_with_temp_mailbox_received_address() {
        let connection = test_connection();
        let message_id = seed_temp_message(
            &connection,
            "temp_1",
            "code@example.test",
            "Your verification code",
            "Use 123456 to continue.",
        );

        let context = load_message_for_verification(&connection, &message_id)
            .expect("load context")
            .expect("message context exists");
        let code =
            extract_verification_code(&context.to_extraction_input(), "2026-06-12T00:12:00Z")
                .expect("extract code");
        persist_verification_code(&connection, &code).expect("persist code");
        let rows = list_recent_verification_codes(
            &connection,
            RecentVerificationCodeFilter {
                temp_mailbox_id: None,
                limit: 10,
            },
        )
        .expect("list recent");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].code, "123456");
        assert_eq!(rows[0].received_address, "code@example.test");
        assert_eq!(rows[0].temp_mailbox_id, Some("temp_1".to_string()));
        assert_eq!(rows[0].message_id, message_id);
    }

    #[test]
    fn recent_codes_can_filter_by_temp_mailbox() {
        let connection = test_connection();
        let first_message_id = seed_temp_message(
            &connection,
            "temp_1",
            "one@example.test",
            "Code 111111",
            "Use 111111.",
        );
        let second_message_id = seed_temp_message(
            &connection,
            "temp_2",
            "two@example.test",
            "Code 222222",
            "Use 222222.",
        );
        for message_id in [first_message_id, second_message_id] {
            let context = load_message_for_verification(&connection, &message_id)
                .expect("load context")
                .expect("message context exists");
            let code =
                extract_verification_code(&context.to_extraction_input(), "2026-06-12T00:12:00Z")
                    .expect("extract code");
            persist_verification_code(&connection, &code).expect("persist code");
        }

        let rows = list_recent_verification_codes(
            &connection,
            RecentVerificationCodeFilter {
                temp_mailbox_id: Some("temp_2".to_string()),
                limit: 10,
            },
        )
        .expect("list recent");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].code, "222222");
        assert_eq!(rows[0].temp_mailbox_id, Some("temp_2".to_string()));
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
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
}
