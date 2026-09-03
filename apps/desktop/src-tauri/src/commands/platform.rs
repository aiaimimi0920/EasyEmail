use super::*;

#[derive(Debug, Clone, Serialize)]
pub struct HealthDto {
    pub status: String,
    pub anonymous_account_id: String,
    pub normal_account_count: usize,
}

#[tauri::command]
pub fn platform_account_get_session() -> PlatformAccountSessionDto {
    dev_platform_account_session(now_rfc3339())
}

#[tauri::command]
pub fn platform_account_query_data(
    request: PlatformAccountQueryRequest,
) -> Result<PlatformAccountQueryDto, ErrorDto> {
    query_dev_platform_account(request, now_rfc3339()).map_err(ErrorDto::from)
}

#[derive(Debug, Clone, Deserialize)]
pub struct EasyEmailSettingsUpdateRequest {
    pub service_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EasyEmailConnectionTestCommandRequest {
    pub service_url: Option<String>,
    pub api_token: Option<String>,
}

#[tauri::command]
pub fn health_check(state: tauri::State<'_, AppState>) -> Result<HealthDto, ErrorDto> {
    let connection = state.connection.lock().map_err(|err| {
        AppError {
            code: "sqlite_connection_lock_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The local database is temporarily unavailable.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: true,
            action_required: ActionRequired::Retry,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        }
        .to_dto()
    })?;

    let anonymous_account_id = ensure_anonymous_virtual_account(&connection, now_rfc3339())
        .map_err(|err| {
            AppError {
                code: "anonymous_account_init_failed".to_string(),
                category: ErrorCategory::Storage,
                user_message: "The anonymous mailbox account could not be initialized.".to_string(),
                technical_message: Some(err.to_string()),
                retryable: false,
                action_required: ActionRequired::None,
                correlation_id: uuid::Uuid::new_v4().to_string(),
                metadata: Box::new(serde_json::json!({})),
            }
            .to_dto()
        })?;

    let normal_account_count = list_normal_accounts(&connection)
        .map_err(|err| {
            AppError {
                code: "normal_account_list_failed".to_string(),
                category: ErrorCategory::Storage,
                user_message: "The account list could not be loaded.".to_string(),
                technical_message: Some(err.to_string()),
                retryable: true,
                action_required: ActionRequired::Retry,
                correlation_id: uuid::Uuid::new_v4().to_string(),
                metadata: Box::new(serde_json::json!({})),
            }
            .to_dto()
        })?
        .len();

    Ok(HealthDto {
        status: "ready".to_string(),
        anonymous_account_id,
        normal_account_count,
    })
}

#[tauri::command]
pub fn settings_get_easyemail(
    state: tauri::State<'_, AppState>,
) -> Result<EasyEmailSettingsDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    get_easyemail_settings(&connection).map_err(ErrorDto::from)
}

#[tauri::command]
pub fn settings_update_easyemail(
    state: tauri::State<'_, AppState>,
    request: EasyEmailSettingsUpdateRequest,
) -> Result<EasyEmailSettingsDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    update_easyemail_settings(&connection, request.service_url, now_rfc3339())
        .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn settings_test_easyemail(
    state: tauri::State<'_, AppState>,
    request: EasyEmailConnectionTestCommandRequest,
) -> Result<crate::easyemail::models::EasyEmailHealth, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = HttpEasyEmailAdapter::default();
    test_easyemail_connection(
        &connection,
        &adapter,
        EasyEmailConnectionTestRequest {
            service_url: request.service_url,
            api_token: request.api_token,
        },
    )
    .map_err(ErrorDto::from)
}
