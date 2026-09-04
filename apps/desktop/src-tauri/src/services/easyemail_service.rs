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
#[path = "easyemail_service_tests.rs"]
mod tests;
