use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct TempCreateMailboxCommandRequest {
    pub api_token: Option<String>,
    pub target_service: Option<String>,
    pub provider_selection: Option<String>,
    pub domain_selection: Option<String>,
    pub local_part: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TempRefreshMailboxCommandRequest {
    pub temp_mailbox_id: String,
    pub api_token: Option<String>,
    pub force: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TempRefreshAnonymousCommandRequest {
    pub api_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TempUpgradeMailboxCommandRequest {
    pub temp_mailbox_id: String,
    pub confirm_lifecycle_ack: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TempMailboxDto {
    pub id: String,
    pub email_address: String,
    pub provider_id: String,
    pub provider_label: String,
    pub visibility_state: String,
    pub lifecycle_state: String,
    pub easyemail_mailbox_id: Option<String>,
    pub lease_expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PromoteTempMailboxDto {
    pub account: AccountDto,
    pub mailbox: TempMailboxDto,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TempRefreshDto {
    pub fetched_count: usize,
    pub inserted_count: usize,
    pub skipped_count: usize,
    pub refreshed_mailbox_ids: Vec<String>,
    pub skipped_mailbox_ids: Vec<String>,
}

#[tauri::command]
pub fn temp_create_mailbox(
    state: tauri::State<'_, AppState>,
    request: TempCreateMailboxCommandRequest,
) -> Result<TempMailboxDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = HttpEasyEmailAdapter::default();
    let mailbox = create_temp_mailbox(
        &connection,
        &adapter,
        CreateTempMailboxServiceRequest {
            api_token: request.api_token,
            request: CreateTempMailboxRequest {
                target_service: request.target_service,
                provider_selection: request.provider_selection,
                domain_selection: request.domain_selection,
                local_part: request.local_part,
                note: request.note,
            },
        },
        now_rfc3339(),
    )
    .map_err(ErrorDto::from)?;

    Ok(temp_mailbox_to_dto(mailbox))
}

#[tauri::command]
pub fn temp_list_mailboxes(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TempMailboxDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let rows = list_temp_mailboxes(&connection).map_err(|err| {
        AppError {
            code: "temp_mailbox_list_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "Temporary mailboxes could not be loaded.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: true,
            action_required: ActionRequired::Retry,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        }
        .to_dto()
    })?;

    Ok(rows.into_iter().map(temp_mailbox_row_to_dto).collect())
}

#[tauri::command]
pub fn temp_upgrade_mailbox(
    state: tauri::State<'_, AppState>,
    request: TempUpgradeMailboxCommandRequest,
) -> Result<PromoteTempMailboxDto, ErrorDto> {
    let mut connection = state.connection.lock().map_err(lock_error)?;
    promote_temp_mailbox(
        &mut connection,
        PromoteTempMailboxRequest {
            temp_mailbox_id: request.temp_mailbox_id,
            confirm_lifecycle_ack: request.confirm_lifecycle_ack,
        },
        now_rfc3339(),
    )
    .map(promote_result_to_dto)
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn temp_refresh_mailbox(
    state: tauri::State<'_, AppState>,
    request: TempRefreshMailboxCommandRequest,
) -> Result<TempRefreshDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = HttpEasyEmailAdapter::default();
    refresh_temp_mailbox(
        &connection,
        &adapter,
        TempRefreshMailboxRequest {
            temp_mailbox_id: request.temp_mailbox_id,
            api_token: request.api_token,
            force: request.force,
        },
        now_rfc3339(),
    )
    .map(refresh_result_to_dto)
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn temp_refresh_anonymous(
    state: tauri::State<'_, AppState>,
    request: TempRefreshAnonymousCommandRequest,
) -> Result<TempRefreshDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = HttpEasyEmailAdapter::default();
    refresh_anonymous_temp_mailboxes(
        &connection,
        &adapter,
        TempRefreshAnonymousRequest {
            api_token: request.api_token,
        },
        now_rfc3339(),
    )
    .map(refresh_result_to_dto)
    .map_err(ErrorDto::from)
}

pub(super) fn temp_mailbox_to_dto(mailbox: TempMailbox) -> TempMailboxDto {
    TempMailboxDto {
        id: mailbox.id,
        email_address: mailbox.email_address,
        provider_id: mailbox.provider_id,
        provider_label: mailbox.provider_label,
        visibility_state: enum_to_dto(mailbox.visibility_state),
        lifecycle_state: enum_to_dto(mailbox.lifecycle_state),
        easyemail_mailbox_id: mailbox.easyemail_mailbox_id,
        lease_expires_at: mailbox.lease_expires_at,
        created_at: mailbox.created_at,
        updated_at: mailbox.updated_at,
    }
}

pub(super) fn temp_mailbox_row_to_dto(row: TempMailboxRow) -> TempMailboxDto {
    TempMailboxDto {
        id: row.id,
        email_address: row.email_address,
        provider_id: row.provider_id,
        provider_label: row.provider_label,
        visibility_state: row.visibility_state,
        lifecycle_state: row.lifecycle_state,
        easyemail_mailbox_id: row.easyemail_mailbox_id,
        lease_expires_at: row.lease_expires_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(super) fn promote_result_to_dto(result: PromoteTempMailboxResult) -> PromoteTempMailboxDto {
    PromoteTempMailboxDto {
        account: account_row_to_dto(result.account),
        mailbox: temp_mailbox_row_to_dto(result.mailbox),
    }
}

pub(super) fn refresh_result_to_dto(result: TempRefreshResult) -> TempRefreshDto {
    TempRefreshDto {
        fetched_count: result.fetched_count,
        inserted_count: result.inserted_count,
        skipped_count: result.skipped_count,
        refreshed_mailbox_ids: result.refreshed_mailbox_ids,
        skipped_mailbox_ids: result.skipped_mailbox_ids,
    }
}

pub(super) fn enum_to_dto<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "unknown".to_string())
}
