use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct SendMessageCommandRequest {
    pub account_id: String,
    pub target_address: String,
    #[serde(default)]
    pub cc_addresses: Vec<String>,
    #[serde(default)]
    pub bcc_addresses: Vec<String>,
    #[serde(default)]
    pub scheduled_at: Option<String>,
    pub subject: String,
    pub body_text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LocalDraftSaveCommandRequest {
    pub draft_id: Option<String>,
    pub account_id: String,
    pub target_address: String,
    #[serde(default)]
    pub cc_addresses: Vec<String>,
    #[serde(default)]
    pub bcc_addresses: Vec<String>,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LocalDraftDeleteCommandRequest {
    pub draft_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SendQueueListCommandRequest {
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SendQueueRunItemCommandRequest {
    pub queue_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SendQueueRunDueBatchCommandRequest {
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SendMessageDto {
    pub message_id: String,
    pub queue_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SendQueueDto {
    pub id: String,
    pub account_id: String,
    pub source_id: String,
    pub message_id: String,
    pub target_address: String,
    pub cc_addresses: Vec<String>,
    pub bcc_addresses: Vec<String>,
    pub subject: String,
    pub status: String,
    pub attempt_count: i64,
    pub next_retry_at: Option<String>,
    pub last_error_code: Option<String>,
    pub last_error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub sent_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LocalDraftSaveDto {
    pub message_id: String,
    pub saved_at: String,
}

#[tauri::command]
pub fn send_message(
    state: tauri::State<'_, AppState>,
    request: SendMessageCommandRequest,
) -> Result<SendMessageDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    enqueue_send_message(
        &connection,
        SendMessageRequest {
            account_id: request.account_id,
            target_address: request.target_address,
            cc_addresses: request.cc_addresses,
            bcc_addresses: request.bcc_addresses,
            scheduled_at: request.scheduled_at,
            subject: request.subject,
            body_text: request.body_text,
        },
        now_rfc3339(),
    )
    .map(send_message_result_to_dto)
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn message_save_local_draft(
    state: tauri::State<'_, AppState>,
    request: LocalDraftSaveCommandRequest,
) -> Result<LocalDraftSaveDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let source = get_smtp_source_for_account(&connection, &request.account_id)
        .map_err(message_list_error)?
        .ok_or_else(|| smtp_source_missing_for_draft(&request.account_id))?;
    let from_address = source
        .account
        .primary_address
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&source.address)
        .to_string();
    let now = now_rfc3339();
    let draft = upsert_local_draft_message(
        &connection,
        NewLocalDraftMessage {
            draft_id: request.draft_id.filter(|value| !value.trim().is_empty()),
            account_id: request.account_id,
            source_id: source.source_id,
            from_address,
            target_address: request.target_address,
            cc_addresses: request.cc_addresses,
            bcc_addresses: request.bcc_addresses,
            subject: request.subject,
            body_text: request.body_text,
            body_html: request.body_html,
            now: now.clone(),
        },
    )
    .map_err(message_list_error)?;

    Ok(LocalDraftSaveDto {
        message_id: draft.id,
        saved_at: now,
    })
}

#[tauri::command]
pub fn message_delete_local_draft(
    state: tauri::State<'_, AppState>,
    request: LocalDraftDeleteCommandRequest,
) -> Result<MessageLocalActionDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let now = now_rfc3339();
    let changed = delete_local_draft_message(&connection, &request.draft_id, &now)
        .map_err(message_list_error)?;
    Ok(MessageLocalActionDto {
        message_id: request.draft_id,
        changed,
        status: if changed { "deleted" } else { "missing" }.to_string(),
        remote_applied: false,
    })
}

#[tauri::command]
pub fn send_queue_list(
    state: tauri::State<'_, AppState>,
    request: SendQueueListCommandRequest,
) -> Result<Vec<SendQueueDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let rows = list_recent_send_queue(&connection, request.limit.unwrap_or(25))
        .map_err(send_queue_list_error)?;

    Ok(rows.into_iter().map(send_queue_row_to_dto).collect())
}

#[tauri::command]
pub fn send_queue_run_once(
    state: tauri::State<'_, AppState>,
) -> Result<SendQueueWorkerRunResult, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = NativeSmtpAdapter;
    let vault = WindowsCredentialManagerVault;
    run_send_queue_once(&connection, &vault, &adapter, now_rfc3339()).map_err(ErrorDto::from)
}

#[tauri::command]
pub fn send_queue_run_due_batch(
    state: tauri::State<'_, AppState>,
    request: SendQueueRunDueBatchCommandRequest,
) -> Result<SendQueueWorkerRunResult, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = NativeSmtpAdapter;
    let vault = WindowsCredentialManagerVault;
    run_send_queue_due_batch(
        &connection,
        &vault,
        &adapter,
        now_rfc3339(),
        request.limit.unwrap_or(10),
    )
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn send_queue_run_item(
    state: tauri::State<'_, AppState>,
    request: SendQueueRunItemCommandRequest,
) -> Result<SendQueueDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = NativeSmtpAdapter;
    let vault = WindowsCredentialManagerVault;
    let now = now_rfc3339();
    run_send_queue_item(&connection, &vault, &adapter, &request.queue_id, now)
        .map_err(ErrorDto::from)?;
    let row = get_send_queue_item(&connection, &request.queue_id)
        .map_err(send_queue_list_error)?
        .ok_or_else(|| {
            ErrorDto::from(AppError::internal(
                "send_queue_item_missing",
                "The queued send could not be found.",
            ))
        })?;

    Ok(send_queue_row_to_dto(row))
}

pub(super) fn send_message_result_to_dto(result: SendMessageResult) -> SendMessageDto {
    SendMessageDto {
        message_id: result.message.id,
        queue_id: result.queue.id,
        status: result.queue.status,
    }
}

pub(super) fn send_queue_row_to_dto(row: SendQueueRow) -> SendQueueDto {
    SendQueueDto {
        id: row.id,
        account_id: row.account_id,
        source_id: row.source_id,
        message_id: row.message_id,
        target_address: row.target_address,
        cc_addresses: row.cc_addresses,
        bcc_addresses: row.bcc_addresses,
        subject: row.subject,
        status: row.status,
        attempt_count: row.attempt_count,
        next_retry_at: row.next_retry_at,
        last_error_code: row.last_error_code,
        last_error_message: row.last_error_message,
        created_at: row.created_at,
        updated_at: row.updated_at,
        sent_at: row.sent_at,
    }
}

pub(super) fn smtp_source_missing_for_draft(account_id: &str) -> ErrorDto {
    AppError {
        code: "smtp_source_missing".to_string(),
        category: ErrorCategory::Validation,
        user_message: "This account does not have an SMTP sending source for drafts.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
    .to_dto()
}

pub(super) fn send_queue_list_error(err: rusqlite::Error) -> ErrorDto {
    AppError {
        code: "send_queue_list_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Send queue items could not be loaded.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}
