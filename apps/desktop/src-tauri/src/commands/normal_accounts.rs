use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct NormalAccountTestImapCommandRequest {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: String,
    pub imap_username: String,
    pub imap_password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NormalAccountAddManualImapCommandRequest {
    pub display_name: String,
    pub email_address: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: String,
    pub imap_username: String,
    pub imap_password: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: String,
    pub smtp_username: String,
    pub smtp_password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NormalAccountSyncRecentCommandRequest {
    pub account_id: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AccountDto {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub display_name: String,
    pub primary_address: Option<String>,
    pub provider_label: Option<String>,
    pub status: String,
    pub auth_status: String,
    pub receive_status: String,
    pub send_status: String,
    pub listed_in_all_accounts: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalImapConnectionTestDto {
    pub authenticated: bool,
    pub capability_summary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalAccountAddDto {
    pub account: AccountDto,
    pub credential_ref_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalAccountSyncDto {
    pub account_id: String,
    pub fetched_count: usize,
    pub inserted_count: usize,
    pub folder_id: String,
}

#[tauri::command]
pub fn account_list_normal(state: tauri::State<'_, AppState>) -> Result<Vec<AccountDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let rows = list_normal_accounts(&connection).map_err(|err| {
        AppError {
            code: "account_list_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "Accounts could not be loaded.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: true,
            action_required: ActionRequired::Retry,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        }
        .to_dto()
    })?;

    Ok(rows.into_iter().map(account_row_to_dto).collect())
}

#[tauri::command]
pub fn normal_account_test_imap(
    request: NormalAccountTestImapCommandRequest,
) -> Result<NormalImapConnectionTestDto, ErrorDto> {
    let adapter = NativeImapAdapter;
    let profile = ImapConnectionProfile {
        host: request.imap_host.trim().to_ascii_lowercase(),
        port: request.imap_port,
        security: request.imap_security.trim().to_ascii_lowercase(),
        username: request.imap_username.trim().to_string(),
    };

    adapter
        .test_connection(&profile, &request.imap_password)
        .map(|result| NormalImapConnectionTestDto {
            authenticated: result.authenticated,
            capability_summary: result.capability_summary,
        })
        .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn normal_account_add_manual_imap(
    state: tauri::State<'_, AppState>,
    request: NormalAccountAddManualImapCommandRequest,
) -> Result<NormalAccountAddDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let imap_adapter = NativeImapAdapter;
    let smtp_adapter = NativeSmtpAdapter;
    let vault = WindowsCredentialManagerVault;
    let result = add_manual_imap_account(
        &connection,
        &vault,
        &imap_adapter,
        &smtp_adapter,
        ManualImapAccountRequest {
            display_name: request.display_name,
            email_address: request.email_address,
            imap_host: request.imap_host,
            imap_port: request.imap_port,
            imap_security: request.imap_security,
            imap_username: request.imap_username,
            imap_password: request.imap_password,
            smtp_host: request.smtp_host,
            smtp_port: request.smtp_port,
            smtp_security: request.smtp_security,
            smtp_username: request.smtp_username,
            smtp_password: request.smtp_password,
        },
        now_rfc3339(),
    )
    .map_err(ErrorDto::from)?;

    Ok(NormalAccountAddDto {
        account: account_row_to_dto(result.account),
        credential_ref_id: result.credential.id,
    })
}

#[tauri::command]
pub fn normal_account_sync_recent(
    state: tauri::State<'_, AppState>,
    request: NormalAccountSyncRecentCommandRequest,
) -> Result<NormalAccountSyncDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = NativeImapAdapter;
    let vault = WindowsCredentialManagerVault;
    let result = sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: request.account_id,
            limit: request.limit.unwrap_or(25),
        },
        now_rfc3339(),
    )
    .map_err(ErrorDto::from)?;

    Ok(sync_result_to_dto(result))
}

pub(super) fn account_row_to_dto(row: AccountRow) -> AccountDto {
    AccountDto {
        id: row.id,
        scope: row.scope,
        kind: row.kind,
        display_name: row.display_name,
        primary_address: row.primary_address,
        provider_label: row.provider_label,
        status: row.status,
        auth_status: row.auth_status,
        receive_status: row.receive_status,
        send_status: row.send_status,
        listed_in_all_accounts: row.listed_in_all_accounts,
    }
}

pub(super) fn sync_result_to_dto(result: SyncRecentHeadersResult) -> NormalAccountSyncDto {
    NormalAccountSyncDto {
        account_id: result.account_id,
        fetched_count: result.fetched_count,
        inserted_count: result.inserted_count,
        folder_id: result.folder_id,
    }
}
