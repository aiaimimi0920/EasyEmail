use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct MessageDetailCommandRequest {
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MessageDetailDto {
    pub message_id: String,
    pub account_id: String,
    pub thread_key: Option<String>,
    pub received_address: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub body_cache_state: String,
    pub draft_cc_addresses: Vec<String>,
    pub draft_bcc_addresses: Vec<String>,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_archived: bool,
    pub is_important: bool,
    pub local_folder: String,
    pub labels: Vec<String>,
}

#[tauri::command]
pub fn message_get_detail(
    state: tauri::State<'_, AppState>,
    request: MessageDetailCommandRequest,
) -> Result<MessageDetailDto, ErrorDto> {
    let adapter = NativeImapAdapter;
    let vault = WindowsCredentialManagerVault;

    // A cache miss fetches the body over IMAP. Release the connection before that
    // round trip so opening an uncached message cannot stall every other command.
    let connection = state.connection.lock().map_err(lock_error)?;
    let plan =
        plan_message_detail(&connection, &vault, &request.message_id).map_err(ErrorDto::from)?;
    drop(connection);

    let body = fetch_planned_message_body(&adapter, &plan).map_err(ErrorDto::from)?;

    let connection = state.connection.lock().map_err(lock_error)?;
    let row = persist_planned_message_body(&connection, plan, body, &now_rfc3339())
        .map_err(ErrorDto::from)?
        .ok_or_else(|| message_detail_not_found(&request.message_id))?;

    Ok(normal_message_detail_to_dto(row))
}

#[tauri::command]
pub fn message_reopen_scheduled_send(
    state: tauri::State<'_, AppState>,
    request: MessageDetailCommandRequest,
) -> Result<MessageDetailDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let now = now_rfc3339();
    let cancelled = cancel_scheduled_send_by_message_id(&connection, &request.message_id, &now)
        .map_err(message_action_error)?
        .ok_or_else(|| scheduled_send_not_pending(&request.message_id))?;
    let converted = convert_scheduled_send_to_local_draft(
        &connection,
        &request.message_id,
        &cancelled.cc_addresses,
        &cancelled.bcc_addresses,
        &now,
    )
    .map_err(message_action_error)?;
    if !converted {
        return Err(message_detail_not_found(&request.message_id));
    }

    let adapter = NativeImapAdapter;
    let vault = WindowsCredentialManagerVault;
    let row =
        load_message_detail_with_imap_body(&connection, &vault, &adapter, &request.message_id, now)
            .map_err(ErrorDto::from)?
            .ok_or_else(|| message_detail_not_found(&request.message_id))?;

    Ok(normal_message_detail_to_dto(row))
}

pub(super) fn normal_message_detail_to_dto(row: NormalMessageDetailRow) -> MessageDetailDto {
    MessageDetailDto {
        message_id: row.message_id,
        account_id: row.account_id,
        thread_key: row.thread_key,
        received_address: row.received_address,
        subject: row.subject,
        from_address: row.from_address,
        snippet: row.snippet,
        observed_at: row.observed_at,
        body_text: row.body_text,
        body_html: row.body_html,
        body_cache_state: row.body_cache_state,
        draft_cc_addresses: row.draft_cc_addresses,
        draft_bcc_addresses: row.draft_bcc_addresses,
        is_read: row.local_state.is_read,
        is_starred: row.local_state.is_starred,
        is_archived: row.local_state.is_archived,
        is_important: row.local_state.is_important,
        local_folder: row.local_state.local_folder,
        labels: row.local_state.labels,
    }
}

pub(super) fn message_detail_not_found(message_id: &str) -> ErrorDto {
    AppError {
        code: "message_detail_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected message no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "message_id": message_id })),
    }
    .to_dto()
}

pub(super) fn scheduled_send_not_pending(message_id: &str) -> ErrorDto {
    AppError {
        code: "scheduled_send_not_pending".to_string(),
        category: ErrorCategory::Validation,
        user_message: "This scheduled send is no longer pending.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "message_id": message_id })),
    }
    .to_dto()
}
