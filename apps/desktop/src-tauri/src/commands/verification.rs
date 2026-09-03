use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct VerificationListRecentCommandRequest {
    pub temp_mailbox_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VerificationReclassifyCommandRequest {
    pub message_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VerificationPollTempMailboxCommandRequest {
    pub temp_mailbox_id: String,
    pub api_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VerificationCodeDto {
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VerificationPollDto {
    pub refresh: TempRefreshDto,
    pub detected_code: Option<VerificationCodeDto>,
}

#[tauri::command]
pub fn verification_list_recent(
    state: tauri::State<'_, AppState>,
    request: VerificationListRecentCommandRequest,
) -> Result<Vec<VerificationCodeDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    list_recent_codes(
        &connection,
        VerificationListRecentRequest {
            temp_mailbox_id: request.temp_mailbox_id,
            limit: request.limit.unwrap_or(25),
        },
    )
    .map(|rows| rows.into_iter().map(verification_code_row_to_dto).collect())
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn verification_reclassify_message(
    state: tauri::State<'_, AppState>,
    request: VerificationReclassifyCommandRequest,
) -> Result<Option<VerificationCodeDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    reclassify_message(
        &connection,
        VerificationReclassifyRequest {
            message_id: request.message_id,
        },
        now_rfc3339(),
    )
    .map(|row| row.map(verification_code_row_to_dto))
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn verification_poll_temp_mailbox(
    state: tauri::State<'_, AppState>,
    request: VerificationPollTempMailboxCommandRequest,
) -> Result<VerificationPollDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = HttpEasyEmailAdapter::default();
    poll_temp_mailbox_for_code(
        &connection,
        &adapter,
        VerificationPollTempMailboxRequest {
            temp_mailbox_id: request.temp_mailbox_id,
            api_token: request.api_token,
        },
        now_rfc3339(),
    )
    .map(verification_poll_result_to_dto)
    .map_err(ErrorDto::from)
}

pub(super) fn verification_code_row_to_dto(row: RecentVerificationCodeRow) -> VerificationCodeDto {
    VerificationCodeDto {
        id: row.id,
        message_id: row.message_id,
        temp_mailbox_id: row.temp_mailbox_id,
        source_id: row.source_id,
        account_scope: row.account_scope,
        received_address: row.received_address,
        code: row.code,
        issuer_hint: row.issuer_hint,
        target_service_hint: row.target_service_hint,
        confidence: row.confidence,
        expires_at: row.expires_at,
        extracted_at: row.extracted_at,
        subject: row.subject,
        from_address: row.from_address,
        observed_at: row.observed_at,
    }
}

pub(super) fn verification_poll_result_to_dto(
    result: VerificationPollResult,
) -> VerificationPollDto {
    VerificationPollDto {
        refresh: refresh_result_to_dto(result.refresh),
        detected_code: result.detected_code.map(verification_code_row_to_dto),
    }
}
