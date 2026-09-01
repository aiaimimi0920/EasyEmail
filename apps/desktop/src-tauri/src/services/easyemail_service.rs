use chrono::DateTime;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::domain::temp_mailbox::TempMailbox;
use crate::easyemail::adapter::EasyEmailAdapter;
use crate::easyemail::models::{
    validate_easyemail_service_url, CreateTempMailboxRequest, EasyEmailConnectionSettings,
    EasyEmailHealth, FetchTempMessagesRequest,
};
use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::redaction::redact_json;
use crate::storage::message_repository::{
    ensure_easyemail_temp_source, persist_observed_messages, PersistObservedMessagesResult,
};
use crate::storage::settings_repository::{
    load_easyemail_settings, save_easyemail_service_url, EasyEmailStoredSettings,
};
use crate::storage::temp_mailbox_repository::{
    get_temp_mailbox, insert_temp_mailbox, list_temp_mailboxes, mark_temp_mailbox_refresh_success,
    update_temp_mailbox_lifecycle, TempMailboxRow,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EasyEmailSettingsDto {
    pub service_url: Option<String>,
    pub has_api_token: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EasyEmailConnectionTestRequest {
    pub service_url: Option<String>,
    pub api_token: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateTempMailboxServiceRequest {
    pub api_token: Option<String>,
    pub request: CreateTempMailboxRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TempRefreshMailboxRequest {
    pub temp_mailbox_id: String,
    pub api_token: Option<String>,
    pub force: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TempRefreshAnonymousRequest {
    pub api_token: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TempRefreshResult {
    pub fetched_count: usize,
    pub inserted_count: usize,
    pub skipped_count: usize,
    pub refreshed_mailbox_ids: Vec<String>,
    pub skipped_mailbox_ids: Vec<String>,
}

pub fn get_easyemail_settings(connection: &Connection) -> Result<EasyEmailSettingsDto, AppError> {
    let settings = load_easyemail_settings(connection).map_err(storage_error)?;
    Ok(settings_to_dto(settings))
}

pub fn update_easyemail_settings(
    connection: &Connection,
    service_url: String,
    now: String,
) -> Result<EasyEmailSettingsDto, AppError> {
    let normalized = validate_easyemail_service_url(&service_url)?;
    save_easyemail_service_url(connection, &normalized, &now).map_err(storage_error)?;

    Ok(EasyEmailSettingsDto {
        service_url: Some(normalized),
        has_api_token: false,
    })
}

pub fn test_easyemail_connection<A: EasyEmailAdapter>(
    connection: &Connection,
    adapter: &A,
    request: EasyEmailConnectionTestRequest,
) -> Result<EasyEmailHealth, AppError> {
    let settings = connection_settings(connection, request.service_url, request.api_token)?;
    adapter.health_check(&settings)
}

pub fn create_temp_mailbox<A: EasyEmailAdapter>(
    connection: &Connection,
    adapter: &A,
    request: CreateTempMailboxServiceRequest,
    now: String,
) -> Result<TempMailbox, AppError> {
    let settings = connection_settings(connection, None, request.api_token)?;
    let created = adapter.create_temp_mailbox(&settings, &request.request)?;
    let raw_provider_snapshot_json = serde_json::to_string(&redact_json(
        &created.raw_provider_snapshot_json,
    ))
    .map_err(|err| AppError {
        code: "easyemail_raw_snapshot_invalid".to_string(),
        category: ErrorCategory::Protocol,
        user_message: "EasyEmail returned provider metadata that could not be stored.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: false,
        action_required: ActionRequired::CheckEasyEmailConnection,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "endpoint": "/mail/mailboxes/open" })),
    })?;
    let mailbox = TempMailbox::from_easyemail(
        created.email_address,
        created.provider_id,
        created.provider_label,
        created.easyemail_mailbox_id,
        created.lease_expires_at,
        raw_provider_snapshot_json,
        now,
    );

    insert_temp_mailbox(connection, &mailbox).map_err(storage_error)?;
    Ok(mailbox)
}

pub fn refresh_temp_mailbox<A: EasyEmailAdapter>(
    connection: &Connection,
    adapter: &A,
    request: TempRefreshMailboxRequest,
    now: String,
) -> Result<TempRefreshResult, AppError> {
    let settings = connection_settings(connection, None, request.api_token)?;
    let row = get_temp_mailbox(connection, &request.temp_mailbox_id)
        .map_err(storage_error)?
        .ok_or_else(|| temp_mailbox_not_found(&request.temp_mailbox_id))?;

    refresh_temp_mailbox_row(connection, adapter, &settings, row, request.force, &now)
}

pub fn refresh_anonymous_temp_mailboxes<A: EasyEmailAdapter>(
    connection: &Connection,
    adapter: &A,
    request: TempRefreshAnonymousRequest,
    now: String,
) -> Result<TempRefreshResult, AppError> {
    let settings = connection_settings(connection, None, request.api_token)?;
    let rows = list_temp_mailboxes(connection).map_err(storage_error)?;
    let mut aggregate = TempRefreshResult::default();

    for row in rows {
        let result = refresh_temp_mailbox_row(connection, adapter, &settings, row, false, &now)?;
        aggregate.fetched_count += result.fetched_count;
        aggregate.inserted_count += result.inserted_count;
        aggregate.skipped_count += result.skipped_count;
        aggregate
            .refreshed_mailbox_ids
            .extend(result.refreshed_mailbox_ids);
        aggregate
            .skipped_mailbox_ids
            .extend(result.skipped_mailbox_ids);
    }

    Ok(aggregate)
}

fn connection_settings(
    connection: &Connection,
    service_url_override: Option<String>,
    api_token: Option<String>,
) -> Result<EasyEmailConnectionSettings, AppError> {
    let service_url = match service_url_override {
        Some(service_url) => validate_easyemail_service_url(&service_url)?,
        None => {
            let stored = load_easyemail_settings(connection).map_err(storage_error)?;
            let service_url = stored
                .service_url
                .ok_or_else(missing_easyemail_service_url)?;
            validate_easyemail_service_url(&service_url)?
        }
    };

    Ok(EasyEmailConnectionSettings {
        service_url,
        api_token: api_token.and_then(|token| {
            let trimmed = token.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }),
    })
}

fn settings_to_dto(settings: EasyEmailStoredSettings) -> EasyEmailSettingsDto {
    EasyEmailSettingsDto {
        service_url: settings.service_url,
        has_api_token: false,
    }
}

fn missing_easyemail_service_url() -> AppError {
    AppError {
        code: "easyemail_service_url_missing".to_string(),
        category: ErrorCategory::Validation,
        user_message: "Configure the EasyEmail service URL before using temporary mailboxes."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

fn storage_error(error: rusqlite::Error) -> AppError {
    AppError {
        code: "sqlite_settings_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "EasyEmailAM could not update local settings.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

fn refresh_temp_mailbox_row<A: EasyEmailAdapter>(
    connection: &Connection,
    adapter: &A,
    settings: &EasyEmailConnectionSettings,
    row: TempMailboxRow,
    force: bool,
    now: &str,
) -> Result<TempRefreshResult, AppError> {
    let mut effective_lifecycle = row.lifecycle_state.clone();
    if temp_mailbox_is_past_lease(&row, now) && effective_lifecycle != "expired" {
        update_temp_mailbox_lifecycle(connection, &row.id, "expired", now)
            .map_err(storage_error)?;
        effective_lifecycle = "expired".to_string();
    }

    if should_skip_refresh(&row, &effective_lifecycle, force) {
        return Ok(TempRefreshResult {
            skipped_count: 1,
            skipped_mailbox_ids: vec![row.id],
            ..TempRefreshResult::default()
        });
    }

    let easyemail_mailbox_id = match row.easyemail_mailbox_id.clone() {
        Some(value) if !value.trim().is_empty() => value,
        _ => {
            return Ok(TempRefreshResult {
                skipped_count: 1,
                skipped_mailbox_ids: vec![row.id],
                ..TempRefreshResult::default()
            });
        }
    };

    let source_id = ensure_easyemail_temp_source(connection, &row, now).map_err(storage_error)?;
    let messages = adapter.fetch_temp_messages(
        settings,
        &FetchTempMessagesRequest {
            easyemail_mailbox_id,
            force_sync: true,
            limit: None,
        },
    )?;
    let persisted: PersistObservedMessagesResult =
        persist_observed_messages(connection, &row, &source_id, &messages, now)
            .map_err(storage_error)?;
    crate::services::verification_service::classify_new_messages(
        connection,
        &persisted.inserted_message_ids,
        now,
    )?;
    mark_temp_mailbox_refresh_success(connection, &row.id, now).map_err(storage_error)?;

    Ok(TempRefreshResult {
        fetched_count: persisted.fetched_count,
        inserted_count: persisted.inserted_count,
        skipped_count: 0,
        refreshed_mailbox_ids: vec![row.id],
        skipped_mailbox_ids: Vec::new(),
    })
}

fn should_skip_refresh(row: &TempMailboxRow, lifecycle_state: &str, force: bool) -> bool {
    if force {
        return false;
    }

    if row.visibility_state != "anonymous" {
        return true;
    }

    !matches!(lifecycle_state, "active" | "expiring")
}

fn temp_mailbox_is_past_lease(row: &TempMailboxRow, now: &str) -> bool {
    let Some(lease_expires_at) = row.lease_expires_at.as_deref() else {
        return false;
    };
    let (Ok(lease_expires_at), Ok(now)) = (
        DateTime::parse_from_rfc3339(lease_expires_at),
        DateTime::parse_from_rfc3339(now),
    ) else {
        return false;
    };

    lease_expires_at <= now
}

fn temp_mailbox_not_found(temp_mailbox_id: &str) -> AppError {
    AppError {
        code: "temp_mailbox_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected temporary mailbox no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "temp_mailbox_id": temp_mailbox_id })),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;

    use crate::easyemail::fake::FakeEasyEmailAdapter;
    use crate::easyemail::models::{
        CreateTempMailboxRequest, EasyEmailObservedMessage, EasyEmailTempMailbox,
    };
    use crate::error::{ActionRequired, ErrorCategory};
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;
    use crate::storage::settings_repository::save_easyemail_service_url;
    use crate::storage::temp_mailbox_repository::get_temp_mailbox;
    use crate::storage::temp_mailbox_repository::insert_temp_mailbox;

    use super::*;

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        save_easyemail_service_url(&connection, "http://127.0.0.1:8080", "2026-06-12T00:00:00Z")
            .expect("save EasyEmail URL");
        connection
    }

    #[test]
    fn blank_easyemail_service_url_is_rejected() {
        let error = validate_easyemail_service_url("   ").expect_err("blank URL rejected");

        assert_eq!(error.code, "easyemail_service_url_invalid");
        assert_eq!(error.category, ErrorCategory::Validation);
        assert_eq!(error.action_required, ActionRequired::EditSettings);
    }

    #[test]
    fn invalid_easyemail_service_url_is_rejected() {
        let error = validate_easyemail_service_url("ftp://127.0.0.1:8080")
            .expect_err("invalid URL rejected");

        assert_eq!(error.code, "easyemail_service_url_invalid");
        assert_eq!(error.category, ErrorCategory::Validation);
        assert_eq!(error.action_required, ActionRequired::EditSettings);
    }

    #[test]
    fn easyemail_service_url_rejects_credentials_paths_and_remote_plaintext() {
        for value in [
            "https://user:password@example.test",
            "https://example.test/api",
            "https://example.test?token=secret",
            "http://example.test",
        ] {
            let error = validate_easyemail_service_url(value).expect_err("unsafe URL rejected");
            assert_eq!(error.code, "easyemail_service_url_invalid", "{value}");
        }
    }

    #[test]
    fn easyemail_service_url_allows_loopback_http_and_remote_https() {
        assert_eq!(
            validate_easyemail_service_url(" http://127.0.0.1:8080/ ").expect("loopback URL"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            validate_easyemail_service_url("http://[::1]:8080/").expect("IPv6 loopback URL"),
            "http://[::1]:8080"
        );
        assert_eq!(
            validate_easyemail_service_url("https://easyemail.example.test/").expect("HTTPS URL"),
            "https://easyemail.example.test"
        );
    }

    #[test]
    fn create_temp_mailbox_saves_canonical_fields() {
        let connection = test_connection();
        let adapter = FakeEasyEmailAdapter::with_mailbox(EasyEmailTempMailbox {
            email_address: "code@example.test".to_string(),
            provider_id: "mailtm".to_string(),
            provider_label: "Mail.tm".to_string(),
            easyemail_mailbox_id: Some("session_123".to_string()),
            lease_expires_at: Some("2026-06-12T01:00:00Z".to_string()),
            raw_provider_snapshot_json: json!({"ignoredProviderInternals": true}),
        });

        let mailbox = create_temp_mailbox(
            &connection,
            &adapter,
            CreateTempMailboxServiceRequest {
                api_token: None,
                request: CreateTempMailboxRequest {
                    target_service: Some("github".to_string()),
                    provider_selection: None,
                    domain_selection: None,
                    local_part: None,
                    note: Some("register github".to_string()),
                },
            },
            "2026-06-12T00:02:00Z".to_string(),
        )
        .expect("create temp mailbox");

        let row = get_temp_mailbox(&connection, &mailbox.id)
            .expect("load temp mailbox")
            .expect("temp mailbox exists");

        assert_eq!(row.email_address, "code@example.test");
        assert_eq!(row.provider_id, "mailtm");
        assert_eq!(row.provider_label, "Mail.tm");
        assert_eq!(row.easyemail_mailbox_id, Some("session_123".to_string()));
        assert_eq!(
            row.lease_expires_at,
            Some("2026-06-12T01:00:00Z".to_string())
        );
        assert_eq!(row.visibility_state, "anonymous");
        assert_eq!(row.lifecycle_state, "active");
    }

    #[test]
    fn create_temp_mailbox_stores_redacted_provider_snapshot() {
        let connection = test_connection();
        let raw_snapshot = json!({
            "session": {
                "id": "session_opaque",
                "emailAddress": "raw@example.test",
                "accessToken": "provider-access-token"
            },
            "providerSpecific": {
                "nested": { "value": 42, "password": "provider-password" }
            }
        });
        let adapter = FakeEasyEmailAdapter::with_mailbox(EasyEmailTempMailbox {
            email_address: "raw@example.test".to_string(),
            provider_id: "opaque-provider".to_string(),
            provider_label: "Opaque Provider".to_string(),
            easyemail_mailbox_id: Some("session_opaque".to_string()),
            lease_expires_at: None,
            raw_provider_snapshot_json: raw_snapshot.clone(),
        });

        let mailbox = create_temp_mailbox(
            &connection,
            &adapter,
            CreateTempMailboxServiceRequest {
                api_token: None,
                request: CreateTempMailboxRequest::default(),
            },
            "2026-06-12T00:03:00Z".to_string(),
        )
        .expect("create temp mailbox");
        let row = get_temp_mailbox(&connection, &mailbox.id)
            .expect("load temp mailbox")
            .expect("temp mailbox exists");
        let stored_raw: serde_json::Value =
            serde_json::from_str(&row.raw_provider_snapshot_json).expect("stored raw JSON");

        assert_eq!(row.provider_id, "opaque-provider");
        assert_eq!(stored_raw["session"]["id"], "session_opaque");
        assert_eq!(stored_raw["providerSpecific"]["nested"]["value"], 42);
        assert_eq!(stored_raw["session"]["accessToken"], "[REDACTED]");
        assert_eq!(
            stored_raw["providerSpecific"]["nested"]["password"],
            "[REDACTED]"
        );
        assert!(!stored_raw.to_string().contains("provider-access-token"));
        assert!(!stored_raw.to_string().contains("provider-password"));
    }

    #[test]
    fn temp_mailbox_lease_comparison_respects_rfc3339_offsets() {
        let connection = test_connection();
        let mailbox = TempMailbox::from_easyemail(
            "offset@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_offset".to_string()),
            Some("2026-06-12T08:00:00+08:00".to_string()),
            "{}".to_string(),
            "2026-06-11T23:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &mailbox).expect("insert offset mailbox");
        let row = get_temp_mailbox(&connection, &mailbox.id)
            .expect("load mailbox")
            .expect("mailbox exists");

        assert!(!temp_mailbox_is_past_lease(&row, "2026-06-11T23:59:59Z"));
        assert!(temp_mailbox_is_past_lease(&row, "2026-06-12T00:00:00Z"));
    }

    #[test]
    fn provider_rate_limit_returns_rate_limit_error() {
        let connection = test_connection();
        let adapter = FakeEasyEmailAdapter::failing(rate_limit_error_for_test());

        let error = create_temp_mailbox(
            &connection,
            &adapter,
            CreateTempMailboxServiceRequest {
                api_token: Some("one-shot-token".to_string()),
                request: CreateTempMailboxRequest::default(),
            },
            "2026-06-12T00:04:00Z".to_string(),
        )
        .expect_err("rate limit should fail");

        assert_eq!(error.category, ErrorCategory::RateLimit);
        assert_eq!(error.action_required, ActionRequired::Wait);
        assert!(error.retryable);
    }

    #[test]
    fn easyemail_token_is_not_present_in_error_dto_metadata() {
        let connection = test_connection();
        let adapter = FakeEasyEmailAdapter::failing(rate_limit_error_for_test());

        let error = create_temp_mailbox(
            &connection,
            &adapter,
            CreateTempMailboxServiceRequest {
                api_token: Some("one-shot-token".to_string()),
                request: CreateTempMailboxRequest::default(),
            },
            "2026-06-12T00:05:00Z".to_string(),
        )
        .expect_err("rate limit should fail");
        let dto = error.to_dto();

        assert!(!dto.metadata.to_string().contains("one-shot-token"));
        assert!(!dto
            .technical_message
            .unwrap_or_default()
            .contains("one-shot-token"));
    }

    #[test]
    fn refresh_anonymous_fetches_only_active_anonymous_mailboxes() {
        let connection = test_connection();
        let active = TempMailbox::from_easyemail(
            "active@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_active".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        let expired = TempMailbox::from_easyemail(
            "expired@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_expired".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        let upgraded = TempMailbox::from_easyemail(
            "upgraded@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_upgraded".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &active).expect("insert active");
        insert_temp_mailbox(&connection, &expired).expect("insert expired");
        insert_temp_mailbox(&connection, &upgraded).expect("insert upgraded");
        connection
            .execute(
                "UPDATE temp_mailboxes SET lifecycle_state = 'expired' WHERE id = ?1",
                rusqlite::params![expired.id],
            )
            .expect("mark expired");
        connection
            .execute(
                "UPDATE temp_mailboxes SET visibility_state = 'upgraded' WHERE id = ?1",
                rusqlite::params![upgraded.id],
            )
            .expect("mark upgraded");
        let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
            "session_active",
            vec![observed_message_for_service(
                "observed_active",
                "session_active",
            )],
        );

        let result = refresh_anonymous_temp_mailboxes(
            &connection,
            &adapter,
            TempRefreshAnonymousRequest { api_token: None },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("refresh anonymous");

        assert_eq!(adapter.fetch_calls(), vec!["session_active".to_string()]);
        assert_eq!(result.fetched_count, 1);
        assert_eq!(result.inserted_count, 1);
        assert_eq!(result.refreshed_mailbox_ids, vec![active.id]);
        assert_eq!(result.skipped_count, 2);
    }

    #[test]
    fn expired_temp_mailbox_is_skipped_unless_forced() {
        let connection = test_connection();
        let expired = TempMailbox::from_easyemail(
            "expired@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_expired".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &expired).expect("insert expired");
        connection
            .execute(
                "UPDATE temp_mailboxes SET lifecycle_state = 'expired' WHERE id = ?1",
                rusqlite::params![expired.id],
            )
            .expect("mark expired");
        let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
            "session_expired",
            vec![observed_message_for_service(
                "observed_expired",
                "session_expired",
            )],
        );

        let skipped = refresh_temp_mailbox(
            &connection,
            &adapter,
            TempRefreshMailboxRequest {
                temp_mailbox_id: expired.id.clone(),
                api_token: None,
                force: false,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("skip expired");
        let forced = refresh_temp_mailbox(
            &connection,
            &adapter,
            TempRefreshMailboxRequest {
                temp_mailbox_id: expired.id.clone(),
                api_token: None,
                force: true,
            },
            "2026-06-12T00:11:00Z".to_string(),
        )
        .expect("force expired");

        assert_eq!(adapter.fetch_calls(), vec!["session_expired".to_string()]);
        assert_eq!(skipped.skipped_count, 1);
        assert_eq!(skipped.inserted_count, 0);
        assert_eq!(forced.fetched_count, 1);
        assert_eq!(forced.inserted_count, 1);
    }

    #[test]
    fn refresh_temp_mailbox_extracts_codes_for_inserted_messages() {
        let connection = test_connection();
        let temp = TempMailbox::from_easyemail(
            "code@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_code".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &temp).expect("insert temp");
        let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
            "session_code",
            vec![observed_message_for_service(
                "observed_code",
                "session_code",
            )],
        );

        refresh_temp_mailbox(
            &connection,
            &adapter,
            TempRefreshMailboxRequest {
                temp_mailbox_id: temp.id.clone(),
                api_token: None,
                force: false,
            },
            "2026-06-12T00:15:00Z".to_string(),
        )
        .expect("refresh temp");

        let rows = crate::storage::verification_repository::list_recent_verification_codes(
            &connection,
            crate::storage::verification_repository::RecentVerificationCodeFilter {
                temp_mailbox_id: Some(temp.id),
                limit: 10,
            },
        )
        .expect("list codes");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].code, "123456");
    }

    fn rate_limit_error_for_test() -> AppError {
        AppError {
            code: "easyemail_rate_limited".to_string(),
            category: ErrorCategory::RateLimit,
            user_message: "EasyEmail is rate limiting mailbox creation. Wait and retry."
                .to_string(),
            technical_message: Some("HTTP 429 at /mail/mailboxes/open".to_string()),
            retryable: true,
            action_required: ActionRequired::Wait,
            correlation_id: "corr_rate_limited".to_string(),
            metadata: Box::new(json!({"endpoint": "/mail/mailboxes/open", "status": 429})),
        }
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
