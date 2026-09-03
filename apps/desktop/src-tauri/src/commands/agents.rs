use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct AgentAddAccountCommandRequest {
    pub display_name: String,
    pub email_address: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentAddServiceCommandRequest {
    pub display_name: String,
    pub email_address: String,
    pub description: Option<String>,
    pub service_kind: Option<String>,
    pub trust_level: String,
    pub default_sender_account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentSendTaskCommandRequest {
    pub agent_service_id: String,
    pub sender_account_id: String,
    pub subject: String,
    pub body_text: String,
    pub confirm_restricted: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentThreadDetailCommandRequest {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentServiceDto {
    pub id: String,
    pub display_name: String,
    pub email_address: String,
    pub description: Option<String>,
    pub service_kind: String,
    pub trust_level: String,
    pub default_sender_account_id: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentThreadDto {
    pub id: String,
    pub agent_service_id: String,
    pub sender_account_id: String,
    pub subject: String,
    pub status: String,
    pub last_outgoing_message_id: Option<String>,
    pub last_incoming_message_id: Option<String>,
    pub correlation_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentMessageDto {
    pub id: String,
    pub thread_id: String,
    pub message_id: String,
    pub direction: String,
    pub semantic_role: String,
    pub parsed_status: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentThreadDetailDto {
    pub thread: AgentThreadDto,
    pub messages: Vec<AgentMessageDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentSendTaskDto {
    pub thread: AgentThreadDto,
    pub agent_message: AgentMessageDto,
    pub queue_id: String,
    pub queue_status: String,
}

#[tauri::command]
pub fn agent_add_account(
    state: tauri::State<'_, AppState>,
    request: AgentAddAccountCommandRequest,
) -> Result<AccountDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    insert_agent_account(
        &connection,
        NewAgentAccount {
            display_name: request.display_name,
            email_address: request.email_address,
            now: now_rfc3339(),
        },
    )
    .map(account_row_to_dto)
    .map_err(agent_storage_error)
}

#[tauri::command]
pub fn agent_list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<AccountDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    list_agent_accounts(&connection)
        .map(|rows| rows.into_iter().map(account_row_to_dto).collect())
        .map_err(agent_storage_error)
}

#[tauri::command]
pub fn agent_add_service(
    state: tauri::State<'_, AppState>,
    request: AgentAddServiceCommandRequest,
) -> Result<AgentServiceDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let service_kind =
        optional_trimmed(request.service_kind).unwrap_or_else(|| "email_agent".to_string());
    insert_agent_service(
        &connection,
        NewAgentService {
            display_name: request.display_name,
            email_address: request.email_address,
            description: optional_trimmed(request.description),
            service_kind,
            trust_level: request.trust_level,
            default_sender_account_id: optional_trimmed(request.default_sender_account_id),
            now: now_rfc3339(),
        },
    )
    .map(agent_service_row_to_dto)
    .map_err(agent_storage_error)
}

#[tauri::command]
pub fn agent_list_services(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentServiceDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    list_agent_services(&connection)
        .map(|rows| rows.into_iter().map(agent_service_row_to_dto).collect())
        .map_err(agent_storage_error)
}

#[tauri::command]
pub fn agent_send_task(
    state: tauri::State<'_, AppState>,
    request: AgentSendTaskCommandRequest,
) -> Result<AgentSendTaskDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    send_agent_task_mail(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: request.agent_service_id,
            sender_account_id: request.sender_account_id,
            subject: request.subject,
            body_text: request.body_text,
            confirm_restricted: request.confirm_restricted,
        },
        now_rfc3339(),
    )
    .map(agent_send_task_result_to_dto)
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn agent_list_threads(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentThreadDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    list_agent_threads(&connection)
        .map(|rows| rows.into_iter().map(agent_thread_row_to_dto).collect())
        .map_err(agent_storage_error)
}

#[tauri::command]
pub fn agent_get_thread_detail(
    state: tauri::State<'_, AppState>,
    request: AgentThreadDetailCommandRequest,
) -> Result<AgentThreadDetailDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let detail = get_agent_thread_detail(&connection, &request.thread_id)
        .map_err(agent_storage_error)?
        .ok_or_else(|| agent_thread_detail_not_found(&request.thread_id))?;

    Ok(agent_thread_detail_to_dto(detail))
}

pub(super) fn agent_service_row_to_dto(row: AgentServiceRow) -> AgentServiceDto {
    AgentServiceDto {
        id: row.id,
        display_name: row.display_name,
        email_address: row.email_address,
        description: row.description,
        service_kind: row.service_kind,
        trust_level: row.trust_level,
        default_sender_account_id: row.default_sender_account_id,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(super) fn agent_thread_row_to_dto(row: AgentThreadRow) -> AgentThreadDto {
    AgentThreadDto {
        id: row.id,
        agent_service_id: row.agent_service_id,
        sender_account_id: row.sender_account_id,
        subject: row.subject,
        status: row.status,
        last_outgoing_message_id: row.last_outgoing_message_id,
        last_incoming_message_id: row.last_incoming_message_id,
        correlation_key: row.correlation_key,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
    }
}

pub(super) fn agent_message_row_to_dto(row: AgentMessageRow) -> AgentMessageDto {
    AgentMessageDto {
        id: row.id,
        thread_id: row.thread_id,
        message_id: row.message_id,
        direction: row.direction,
        semantic_role: row.semantic_role,
        parsed_status: row.parsed_status,
        created_at: row.created_at,
    }
}

pub(super) fn agent_thread_detail_to_dto(detail: AgentThreadDetail) -> AgentThreadDetailDto {
    AgentThreadDetailDto {
        thread: agent_thread_row_to_dto(detail.thread),
        messages: detail
            .messages
            .into_iter()
            .map(agent_message_row_to_dto)
            .collect(),
    }
}

pub(super) fn agent_send_task_result_to_dto(result: AgentSendTaskResult) -> AgentSendTaskDto {
    AgentSendTaskDto {
        thread: agent_thread_row_to_dto(result.thread),
        agent_message: agent_message_row_to_dto(result.agent_message),
        queue_id: result.queue.id,
        queue_status: result.queue.status,
    }
}

pub(super) fn optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

pub(super) fn agent_storage_error(err: rusqlite::Error) -> ErrorDto {
    AppError {
        code: "agent_storage_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Agent mailbox state could not be loaded or updated.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}

pub(super) fn agent_thread_detail_not_found(thread_id: &str) -> ErrorDto {
    AppError {
        code: "agent_thread_detail_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected Agent thread no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "thread_id": thread_id })),
    }
    .to_dto()
}
