use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::avatar::{
    clear_avatar_cache, clear_contact_avatar, fetch_pending_avatars, load_avatar_settings,
    persist_fetched_avatars, plan_sender_avatar_resolution, save_avatar_settings,
    set_contact_avatar, AvatarSettingsDto, SenderAvatarDto,
};
use crate::domain::temp_mailbox::TempMailbox;
use crate::easyemail::http::HttpEasyEmailAdapter;
use crate::easyemail::models::CreateTempMailboxRequest;
use crate::error::{ActionRequired, AppError, ErrorCategory, ErrorDto};
use crate::imap::adapter::ImapAdapter;
use crate::imap::models::ImapConnectionProfile;
use crate::imap::native::NativeImapAdapter;
use crate::secret::windows::WindowsCredentialManagerVault;
use crate::services::agent_service::{
    agent_send_task as send_agent_task_mail, AgentSendTaskRequest, AgentSendTaskResult,
};
use crate::services::easyemail_service::{
    create_temp_mailbox, get_easyemail_settings, refresh_anonymous_temp_mailboxes,
    refresh_temp_mailbox, test_easyemail_connection, update_easyemail_settings,
    CreateTempMailboxServiceRequest, EasyEmailConnectionTestRequest, EasyEmailSettingsDto,
    TempRefreshAnonymousRequest, TempRefreshMailboxRequest, TempRefreshResult,
};
use crate::services::normal_account_service::{
    add_manual_imap_account, apply_normal_message_action, fetch_planned_message_body,
    fetch_planned_move, load_message_detail_with_imap_body, persist_planned_message_body,
    persist_planned_move, persist_planned_remote_flag, plan_archive_action, plan_message_detail,
    plan_move_action, plan_permanent_delete_action, plan_remote_flag_action,
    push_planned_remote_flag, sync_recent_headers, ManualImapAccountRequest, NormalMessageAction,
    NormalMessageActionRequest, NormalMessageActionResult, RemoteFlagKind,
    SyncRecentHeadersRequest, SyncRecentHeadersResult,
};
use crate::services::platform_account_service::{
    dev_platform_account_session, query_dev_platform_account, PlatformAccountQueryDto,
    PlatformAccountQueryRequest, PlatformAccountSessionDto,
};
use crate::services::send_service::{enqueue_send_message, SendMessageRequest, SendMessageResult};
use crate::services::temp_mailbox_service::{
    promote_temp_mailbox, PromoteTempMailboxRequest, PromoteTempMailboxResult,
};
use crate::services::verification_service::{
    list_recent_codes, poll_temp_mailbox_for_code, reclassify_message,
    VerificationListRecentRequest, VerificationPollResult, VerificationPollTempMailboxRequest,
    VerificationReclassifyRequest,
};
use crate::smtp::native::NativeSmtpAdapter;
use crate::storage::account_repository::{
    ensure_anonymous_virtual_account, get_smtp_source_for_account, insert_agent_account,
    list_agent_accounts, list_normal_accounts, AccountRow, NewAgentAccount,
};
use crate::storage::agent_repository::{
    get_agent_thread_detail, insert_agent_service, list_agent_services, list_agent_threads,
    AgentMessageRow, AgentServiceRow, AgentThreadDetail, AgentThreadRow, NewAgentService,
};
use crate::storage::contact_repository::{create_contact, list_contacts, ContactRow, NewContact};
use crate::storage::mail_taxonomy_repository::{
    delete_mail_taxonomy_item, get_mail_taxonomy_item, list_mail_taxonomy_items,
    update_mail_taxonomy_item, upsert_mail_taxonomy_item, MailTaxonomyItemRow, NewMailTaxonomyItem,
};
#[cfg(test)]
use crate::storage::message_repository::MessageLocalState;
use crate::storage::message_repository::{
    clear_message_source_folder_name, clear_message_source_label_name,
};
use crate::storage::message_repository::{
    convert_scheduled_send_to_local_draft, delete_local_draft_message,
    list_anonymous_messages_with_options, list_newsletter_subscriptions,
    list_normal_account_messages_with_options, list_promoted_account_messages_with_options,
    replace_message_source_folder_name, replace_message_source_label_name, set_message_source_flag,
    set_message_source_label, set_newsletter_subscription_hidden, upsert_local_draft_message,
    AnonymousMessageRow, NewLocalDraftMessage, NewsletterSubscriptionRow, NormalAccountMessageRow,
    NormalMessageDetailRow, PromotedAccountMessageRow,
};
use crate::storage::send_queue_repository::{
    cancel_scheduled_send_by_message_id, get_send_queue_item, list_recent_send_queue, SendQueueRow,
};
use crate::storage::temp_mailbox_repository::{list_temp_mailboxes, TempMailboxRow};
use crate::storage::verification_repository::RecentVerificationCodeRow;
use crate::time::now_rfc3339;
use crate::workers::send_queue_worker::{
    run_send_queue_due_batch, run_send_queue_item, run_send_queue_once, SendQueueWorkerRunResult,
};

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

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarSettingsUpdateRequest {
    pub remote_enabled: bool,
    pub bimi_enabled: bool,
    pub favicon_enabled: bool,
    pub auth_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarResolveRequest {
    pub senders: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarContactRequest {
    pub sender: String,
    pub image_data_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarClearContactRequest {
    pub sender: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarClearCacheRequest {
    pub include_contacts: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AvatarClearCacheDto {
    pub deleted_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AvatarClearContactDto {
    pub changed: bool,
}

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

#[derive(Debug, Clone, Deserialize)]
pub struct ContactCreateCommandRequest {
    pub display_name: String,
    pub email_address: String,
    pub note: Option<String>,
}

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

#[derive(Debug, Clone, Deserialize)]
pub struct MessageListCommandRequest {
    pub scope: String,
    pub account_id: Option<String>,
    pub include_archived: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewsletterSubscriptionListCommandRequest {
    pub account_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewsletterSubscriptionSetHiddenCommandRequest {
    pub account_id: String,
    pub subscription_id: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MailTaxonomyListCommandRequest {
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MailTaxonomyUpsertCommandRequest {
    pub kind: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MailTaxonomyUpdateCommandRequest {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MailTaxonomyDeleteCommandRequest {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageDetailCommandRequest {
    pub message_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageDeleteLocalCommandRequest {
    pub message_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageDeleteForeverCommandRequest {
    pub message_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageEmptyTrashCommandRequest {
    pub message_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageSetLocalFlagCommandRequest {
    pub message_id: String,
    pub flag_name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageSetLocalFolderCommandRequest {
    pub message_id: String,
    pub folder_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageSetLocalLabelCommandRequest {
    pub message_id: String,
    pub label_name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TempUpgradeMailboxCommandRequest {
    pub temp_mailbox_id: String,
    pub confirm_lifecycle_ack: bool,
}

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
pub struct ContactDto {
    pub id: String,
    pub display_name: String,
    pub email_address: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AnonymousMessageDto {
    pub message_id: String,
    pub thread_key: Option<String>,
    pub temp_mailbox_id: String,
    pub received_address: String,
    pub provider_label: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub lifecycle_state: String,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_archived: bool,
    pub is_important: bool,
    pub local_folder: String,
    pub labels: Vec<String>,
    pub newsletter_subscription_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NewsletterSubscriptionDto {
    pub id: String,
    pub list_id: String,
    pub sender_address: String,
    pub name: String,
    pub received_message_count: usize,
    pub unread_message_count: usize,
    pub last_received_at: String,
    pub unsubscribe_methods: Vec<String>,
    pub spam: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NewsletterSubscriptionActionDto {
    pub account_id: String,
    pub subscription_id: String,
    pub hidden: bool,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MailTaxonomyItemDto {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: String,
    pub sort_order: i64,
    pub system: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MailTaxonomyDeleteDto {
    pub id: String,
    pub changed: bool,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MessageLocalActionDto {
    pub message_id: String,
    pub changed: bool,
    pub status: String,
    pub remote_applied: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LocalDraftSaveDto {
    pub message_id: String,
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MessageBatchActionDto {
    pub requested_count: usize,
    pub changed_count: usize,
    pub remote_applied_count: usize,
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

#[tauri::command]
pub fn avatar_get_settings(
    state: tauri::State<'_, AppState>,
) -> Result<AvatarSettingsDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    load_avatar_settings(&connection).map_err(ErrorDto::from)
}

#[tauri::command]
pub fn avatar_update_settings(
    state: tauri::State<'_, AppState>,
    request: AvatarSettingsUpdateRequest,
) -> Result<AvatarSettingsDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    save_avatar_settings(
        &connection,
        AvatarSettingsDto {
            remote_enabled: request.remote_enabled,
            bimi_enabled: request.bimi_enabled,
            favicon_enabled: request.favicon_enabled,
            auth_enabled: request.auth_enabled,
        },
    )
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn avatar_resolve_senders(
    state: tauri::State<'_, AppState>,
    request: AvatarResolveRequest,
) -> Result<Vec<SenderAvatarDto>, ErrorDto> {
    // Remote avatar lookups are HTTP and DNS-over-HTTPS calls that can take tens
    // of seconds on a cold cache. The database lock is released between the read
    // and write phases so those fetches do not block every other command.
    let plan = {
        let connection = state.connection.lock().map_err(lock_error)?;
        plan_sender_avatar_resolution(&connection, request.senders)?
    };

    if !plan.has_pending() {
        let connection = state.connection.lock().map_err(lock_error)?;
        return persist_fetched_avatars(&connection, plan, Vec::new()).map_err(ErrorDto::from);
    }

    let fetched = fetch_pending_avatars(&plan);

    let connection = state.connection.lock().map_err(lock_error)?;
    persist_fetched_avatars(&connection, plan, fetched).map_err(ErrorDto::from)
}

#[tauri::command]
pub fn avatar_set_contact(
    state: tauri::State<'_, AppState>,
    request: AvatarContactRequest,
) -> Result<SenderAvatarDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    set_contact_avatar(&connection, &request.sender, &request.image_data_url)
        .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn avatar_clear_contact(
    state: tauri::State<'_, AppState>,
    request: AvatarClearContactRequest,
) -> Result<AvatarClearContactDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let changed = clear_contact_avatar(&connection, &request.sender).map_err(ErrorDto::from)?;
    Ok(AvatarClearContactDto { changed })
}

#[tauri::command]
pub fn avatar_clear_cache(
    state: tauri::State<'_, AppState>,
    request: AvatarClearCacheRequest,
) -> Result<AvatarClearCacheDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let deleted_count =
        clear_avatar_cache(&connection, request.include_contacts).map_err(ErrorDto::from)?;
    Ok(AvatarClearCacheDto { deleted_count })
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

#[tauri::command]
pub fn contact_list(state: tauri::State<'_, AppState>) -> Result<Vec<ContactDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let rows = list_contacts(&connection).map_err(contact_storage_error)?;
    Ok(rows.into_iter().map(contact_row_to_dto).collect())
}

#[tauri::command]
pub fn contact_create(
    state: tauri::State<'_, AppState>,
    request: ContactCreateCommandRequest,
) -> Result<ContactDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let row = create_contact(
        &connection,
        NewContact {
            display_name: request.display_name,
            email_address: request.email_address,
            note: request.note,
            now: now_rfc3339(),
        },
    )
    .map_err(contact_storage_error)?;
    Ok(contact_row_to_dto(row))
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

#[tauri::command]
pub fn message_list(
    state: tauri::State<'_, AppState>,
    request: MessageListCommandRequest,
) -> Result<Vec<AnonymousMessageDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let include_archived = request.include_archived.unwrap_or(false);
    match request.scope.trim() {
        "anonymous" => {
            let rows = list_anonymous_messages_with_options(&connection, include_archived)
                .map_err(message_list_error)?;
            Ok(rows.into_iter().map(anonymous_message_row_to_dto).collect())
        }
        "promoted_account" => {
            let account_id = request
                .account_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| promoted_account_id_required(&request.scope))?;
            let rows = list_promoted_account_messages_with_options(
                &connection,
                account_id,
                include_archived,
            )
            .map_err(message_list_error)?;
            Ok(rows.into_iter().map(promoted_message_row_to_dto).collect())
        }
        "normal_account" => {
            let account_id = request
                .account_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| normal_account_id_required(&request.scope))?;
            let rows = list_normal_account_messages_with_options(
                &connection,
                account_id,
                include_archived,
            )
            .map_err(message_list_error)?;
            Ok(rows.into_iter().map(normal_message_row_to_dto).collect())
        }
        _ => Err(message_scope_unsupported(request.scope)),
    }
}

#[tauri::command]
pub fn newsletter_subscription_list(
    state: tauri::State<'_, AppState>,
    request: NewsletterSubscriptionListCommandRequest,
) -> Result<Vec<NewsletterSubscriptionDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    list_newsletter_subscriptions(&connection, request.account_id.trim())
        .map(|rows| {
            rows.into_iter()
                .map(newsletter_subscription_row_to_dto)
                .collect()
        })
        .map_err(message_list_error)
}

#[tauri::command]
pub fn newsletter_subscription_set_hidden(
    state: tauri::State<'_, AppState>,
    request: NewsletterSubscriptionSetHiddenCommandRequest,
) -> Result<NewsletterSubscriptionActionDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let account_id = request.account_id.trim().to_string();
    let subscription_id = request.subscription_id.trim().to_string();
    let changed = set_newsletter_subscription_hidden(
        &connection,
        &account_id,
        &subscription_id,
        request.hidden,
        &now_rfc3339(),
    )
    .map_err(message_list_error)?;

    Ok(NewsletterSubscriptionActionDto {
        account_id,
        subscription_id,
        hidden: request.hidden,
        changed,
    })
}

#[tauri::command]
pub fn mail_taxonomy_list(
    state: tauri::State<'_, AppState>,
    request: MailTaxonomyListCommandRequest,
) -> Result<Vec<MailTaxonomyItemDto>, ErrorDto> {
    let kind = normalize_taxonomy_kind(&request.kind)?;
    let connection = state.connection.lock().map_err(lock_error)?;
    list_mail_taxonomy_items(&connection, &kind)
        .map(|rows| rows.into_iter().map(mail_taxonomy_row_to_dto).collect())
        .map_err(message_list_error)
}

#[tauri::command]
pub fn mail_taxonomy_upsert(
    state: tauri::State<'_, AppState>,
    request: MailTaxonomyUpsertCommandRequest,
) -> Result<MailTaxonomyItemDto, ErrorDto> {
    let kind = normalize_taxonomy_kind(&request.kind)?;
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(message_label_invalid(name));
    }
    let connection = state.connection.lock().map_err(lock_error)?;
    let parent_id = if kind == "folder" {
        sanitize_mail_taxonomy_parent_id(&connection, &request.parent_id)?
    } else if request
        .parent_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(mail_taxonomy_validation_error(
            "mail_taxonomy_parent_unsupported",
            "Labels cannot have a parent folder.",
        ));
    } else {
        None
    };
    upsert_mail_taxonomy_item(
        &connection,
        NewMailTaxonomyItem {
            kind,
            name: name.to_string(),
            parent_id,
            color: request.color,
            now: now_rfc3339(),
        },
    )
    .map(mail_taxonomy_row_to_dto)
    .map_err(message_list_error)
}

#[tauri::command]
pub fn mail_taxonomy_update(
    state: tauri::State<'_, AppState>,
    request: MailTaxonomyUpdateCommandRequest,
) -> Result<MailTaxonomyItemDto, ErrorDto> {
    let item_id = request.id.trim();
    let name = request.name.trim();
    if item_id.is_empty() {
        return Err(mail_taxonomy_not_found(item_id));
    }
    if name.is_empty() || name.chars().count() > 64 {
        return Err(message_label_invalid(name));
    }

    let now = now_rfc3339();
    let mut connection = state.connection.lock().map_err(lock_error)?;
    let transaction = connection.transaction().map_err(message_list_error)?;
    let old_item = get_mail_taxonomy_item(&transaction, item_id)
        .map_err(message_list_error)?
        .ok_or_else(|| mail_taxonomy_not_found(item_id))?;
    let sanitized_parent_id = sanitize_mail_taxonomy_parent_id(&transaction, &request.parent_id)?;
    if old_item.kind == "folder" {
        validate_mail_taxonomy_parent_folder(
            &transaction,
            sanitized_parent_id.as_deref(),
            item_id,
        )?;
    } else if sanitized_parent_id.is_some() {
        return Err(mail_taxonomy_validation_error(
            "mail_taxonomy_parent_unsupported",
            "Labels cannot have a parent folder.",
        ));
    }
    let updated_item = update_mail_taxonomy_item(
        &transaction,
        item_id,
        name,
        sanitized_parent_id.as_deref(),
        &request.color,
        &now,
    )
    .map_err(message_list_error)?
    .ok_or_else(|| mail_taxonomy_not_found(item_id))?;

    if !old_item.name.eq_ignore_ascii_case(&updated_item.name) {
        if updated_item.kind == "folder" {
            replace_message_source_folder_name(
                &transaction,
                &old_item.name,
                &updated_item.name,
                &now,
            )
            .map_err(message_list_error)?;
        } else {
            replace_message_source_label_name(
                &transaction,
                &old_item.name,
                &updated_item.name,
                &now,
            )
            .map_err(message_list_error)?;
        }
    }

    transaction.commit().map_err(message_list_error)?;
    Ok(mail_taxonomy_row_to_dto(updated_item))
}

#[tauri::command]
pub fn mail_taxonomy_delete(
    state: tauri::State<'_, AppState>,
    request: MailTaxonomyDeleteCommandRequest,
) -> Result<MailTaxonomyDeleteDto, ErrorDto> {
    let item_id = request.id.trim();
    if item_id.is_empty() {
        return Err(mail_taxonomy_not_found(item_id));
    }

    let now = now_rfc3339();
    let mut connection = state.connection.lock().map_err(lock_error)?;
    let transaction = connection.transaction().map_err(message_list_error)?;
    let item = get_mail_taxonomy_item(&transaction, item_id)
        .map_err(message_list_error)?
        .ok_or_else(|| mail_taxonomy_not_found(item_id))?;
    let changed = delete_mail_taxonomy_item(&transaction, item_id).map_err(message_list_error)?;

    if changed {
        if item.kind == "folder" {
            clear_message_source_folder_name(&transaction, &item.name, &now)
                .map_err(message_list_error)?;
        } else {
            clear_message_source_label_name(&transaction, &item.name, &now)
                .map_err(message_list_error)?;
        }
    }

    transaction.commit().map_err(message_list_error)?;
    Ok(MailTaxonomyDeleteDto {
        id: item_id.to_string(),
        changed,
    })
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

#[tauri::command]
pub fn message_delete_local(
    state: tauri::State<'_, AppState>,
    request: MessageDeleteLocalCommandRequest,
) -> Result<MessageLocalActionDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = NativeImapAdapter;
    let vault = WindowsCredentialManagerVault;
    let result = apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: request.message_id,
            action: NormalMessageAction::Delete,
        },
        now_rfc3339(),
    )
    .map_err(ErrorDto::from)?;

    Ok(normal_action_result_to_dto(result))
}

#[tauri::command]
pub fn message_delete_forever(
    state: tauri::State<'_, AppState>,
    request: MessageDeleteForeverCommandRequest,
) -> Result<MessageLocalActionDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let adapter = NativeImapAdapter;
    let vault = WindowsCredentialManagerVault;

    // Plan under the lock, release it for the IMAP round trip, then re-acquire to
    // persist, so a slow server does not block every other command.
    let plan = plan_permanent_delete_action(&connection, &vault, request.message_id.trim())
        .map_err(ErrorDto::from)?;
    if !plan.needs_remote() {
        let result = persist_planned_remote_flag(&connection, plan, &now_rfc3339())
            .map_err(ErrorDto::from)?;
        return Ok(normal_action_result_to_dto(result));
    }

    drop(connection);
    push_planned_remote_flag(&adapter, &plan).map_err(ErrorDto::from)?;
    let connection = state.connection.lock().map_err(lock_error)?;
    let result =
        persist_planned_remote_flag(&connection, plan, &now_rfc3339()).map_err(ErrorDto::from)?;

    Ok(normal_action_result_to_dto(result))
}

#[tauri::command]
pub fn message_empty_trash(
    state: tauri::State<'_, AppState>,
    request: MessageEmptyTrashCommandRequest,
) -> Result<MessageBatchActionDto, ErrorDto> {
    let adapter = NativeImapAdapter;
    let vault = WindowsCredentialManagerVault;
    let mut requested_ids = Vec::new();
    for message_id in request.message_ids {
        let trimmed = message_id.trim();
        if !trimmed.is_empty() && !requested_ids.iter().any(|existing| existing == trimmed) {
            requested_ids.push(trimmed.to_string());
        }
    }

    let mut changed_count = 0;
    let mut remote_applied_count = 0;
    for message_id in &requested_ids {
        // Each deletion performs its own IMAP round trip, so the lock is dropped
        // for every one of them: emptying a large trash folder must not serialize
        // other commands behind either a single slow server or the whole batch.
        // There is no transaction spanning the batch, so an error partway through
        // leaves the earlier deletions committed, as it did before.
        let connection = state.connection.lock().map_err(lock_error)?;
        let plan = plan_permanent_delete_action(&connection, &vault, message_id)
            .map_err(ErrorDto::from)?;

        let result = if plan.needs_remote() {
            drop(connection);
            push_planned_remote_flag(&adapter, &plan).map_err(ErrorDto::from)?;
            let connection = state.connection.lock().map_err(lock_error)?;
            persist_planned_remote_flag(&connection, plan, &now_rfc3339())
                .map_err(ErrorDto::from)?
        } else {
            persist_planned_remote_flag(&connection, plan, &now_rfc3339())
                .map_err(ErrorDto::from)?
        };

        if result.changed {
            changed_count += 1;
        }
        if result.remote_applied {
            remote_applied_count += 1;
        }
    }

    Ok(MessageBatchActionDto {
        requested_count: requested_ids.len(),
        changed_count,
        remote_applied_count,
    })
}

#[tauri::command]
pub fn message_set_local_flag(
    state: tauri::State<'_, AppState>,
    request: MessageSetLocalFlagCommandRequest,
) -> Result<MessageLocalActionDto, ErrorDto> {
    let flag_name = request.flag_name.trim();
    if !matches!(flag_name, "archived" | "read" | "starred" | "important") {
        return Err(message_flag_unsupported(flag_name));
    }

    let connection = state.connection.lock().map_err(lock_error)?;
    if matches!(flag_name, "important" | "starred") {
        let changed = set_message_source_flag(
            &connection,
            &request.message_id,
            flag_name,
            request.enabled,
            &now_rfc3339(),
        )
        .map_err(message_action_error)?;
        return Ok(MessageLocalActionDto {
            message_id: request.message_id,
            changed,
            status: if request.enabled {
                flag_name.to_string()
            } else {
                format!("{flag_name}_cleared")
            },
            remote_applied: false,
        });
    }

    let adapter = NativeImapAdapter;
    let vault = WindowsCredentialManagerVault;

    // "read" and "starred" push a flag over IMAP. Plan under the lock, release it
    // for the round trip, then re-acquire to persist, so a slow or hung server
    // does not serialize every other command behind this one.
    if let Some(kind) = match flag_name {
        "read" => Some(RemoteFlagKind::Read),
        "starred" => Some(RemoteFlagKind::Starred),
        _ => None,
    } {
        let plan = plan_remote_flag_action(
            &connection,
            &vault,
            request.message_id.trim(),
            kind,
            request.enabled,
        )
        .map_err(ErrorDto::from)?;

        if !plan.needs_remote() {
            let result = persist_planned_remote_flag(&connection, plan, &now_rfc3339())
                .map_err(ErrorDto::from)?;
            return Ok(normal_action_result_to_dto(result));
        }

        drop(connection);
        push_planned_remote_flag(&adapter, &plan).map_err(ErrorDto::from)?;
        let connection = state.connection.lock().map_err(lock_error)?;
        let result = persist_planned_remote_flag(&connection, plan, &now_rfc3339())
            .map_err(ErrorDto::from)?;
        return Ok(normal_action_result_to_dto(result));
    }

    // Archiving moves the message into the archive folder over IMAP, so it gets
    // the same treatment: plan under the lock, release it for the round trip,
    // re-acquire to persist. An uncached archive folder needs discovery
    // interleaved with folder-id writes, so that case keeps the locked path.
    let now = now_rfc3339();
    let plan = plan_archive_action(
        &connection,
        &vault,
        request.message_id.trim(),
        request.enabled,
    )
    .map_err(ErrorDto::from)?;

    if plan.requires_locked_fallback() {
        let result = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: request.message_id,
                action: NormalMessageAction::SetArchived(request.enabled),
            },
            now,
        )
        .map_err(ErrorDto::from)?;
        return Ok(normal_action_result_to_dto(result));
    }

    if !plan.needs_remote() {
        let result = persist_planned_move(&connection, plan, None, &now).map_err(ErrorDto::from)?;
        return Ok(normal_action_result_to_dto(result));
    }

    drop(connection);
    let move_result = fetch_planned_move(&adapter, &plan).map_err(ErrorDto::from)?;
    let connection = state.connection.lock().map_err(lock_error)?;
    let result =
        persist_planned_move(&connection, plan, move_result, &now).map_err(ErrorDto::from)?;

    Ok(normal_action_result_to_dto(result))
}

#[tauri::command]
pub fn message_set_local_folder(
    state: tauri::State<'_, AppState>,
    request: MessageSetLocalFolderCommandRequest,
) -> Result<MessageLocalActionDto, ErrorDto> {
    let folder_name = request.folder_name.trim();
    if folder_name.is_empty() || folder_name.chars().count() > 64 {
        return Err(message_folder_unsupported(folder_name));
    }

    let now = now_rfc3339();
    let adapter = NativeImapAdapter;
    let vault = WindowsCredentialManagerVault;
    let connection = state.connection.lock().map_err(lock_error)?;
    let plan = plan_move_action(&connection, &vault, request.message_id.trim(), folder_name)
        .map_err(ErrorDto::from)?;

    // An uncached target folder has to be discovered over the network, and that
    // discovery is interleaved with the writes that assign folder ids, so it
    // cannot run lock-free. Fall back to the fully locked path, whose behaviour
    // is unchanged. A synced account resolves from cache and skips this.
    if plan.requires_locked_fallback() {
        let result = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: request.message_id,
                action: NormalMessageAction::MoveTo(folder_name.to_string()),
            },
            now,
        )
        .map_err(ErrorDto::from)?;
        return Ok(normal_action_result_to_dto(result));
    }

    // Nothing to send, so there is no round trip to make room for: keep the lock.
    if !plan.needs_remote() {
        let result = persist_planned_move(&connection, plan, None, &now).map_err(ErrorDto::from)?;
        return Ok(normal_action_result_to_dto(result));
    }

    // Release the lock across the IMAP move so a slow or hung server does not
    // serialize every other command behind it.
    drop(connection);
    let move_result = fetch_planned_move(&adapter, &plan).map_err(ErrorDto::from)?;
    let connection = state.connection.lock().map_err(lock_error)?;
    let result =
        persist_planned_move(&connection, plan, move_result, &now).map_err(ErrorDto::from)?;

    Ok(normal_action_result_to_dto(result))
}

#[tauri::command]
pub fn message_set_local_label(
    state: tauri::State<'_, AppState>,
    request: MessageSetLocalLabelCommandRequest,
) -> Result<MessageLocalActionDto, ErrorDto> {
    let label_name = request.label_name.trim();
    if label_name.is_empty() || label_name.chars().count() > 32 {
        return Err(message_label_invalid(label_name));
    }

    let connection = state.connection.lock().map_err(lock_error)?;
    let changed = set_message_source_label(
        &connection,
        &request.message_id,
        label_name,
        request.enabled,
        &now_rfc3339(),
    )
    .map_err(message_action_error)?;

    Ok(MessageLocalActionDto {
        message_id: request.message_id,
        changed,
        status: if request.enabled {
            format!("label:{label_name}")
        } else {
            format!("label_removed:{label_name}")
        },
        remote_applied: false,
    })
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

fn temp_mailbox_to_dto(mailbox: TempMailbox) -> TempMailboxDto {
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

fn temp_mailbox_row_to_dto(row: TempMailboxRow) -> TempMailboxDto {
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

fn account_row_to_dto(row: AccountRow) -> AccountDto {
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

fn promote_result_to_dto(result: PromoteTempMailboxResult) -> PromoteTempMailboxDto {
    PromoteTempMailboxDto {
        account: account_row_to_dto(result.account),
        mailbox: temp_mailbox_row_to_dto(result.mailbox),
    }
}

fn refresh_result_to_dto(result: TempRefreshResult) -> TempRefreshDto {
    TempRefreshDto {
        fetched_count: result.fetched_count,
        inserted_count: result.inserted_count,
        skipped_count: result.skipped_count,
        refreshed_mailbox_ids: result.refreshed_mailbox_ids,
        skipped_mailbox_ids: result.skipped_mailbox_ids,
    }
}

fn sync_result_to_dto(result: SyncRecentHeadersResult) -> NormalAccountSyncDto {
    NormalAccountSyncDto {
        account_id: result.account_id,
        fetched_count: result.fetched_count,
        inserted_count: result.inserted_count,
        folder_id: result.folder_id,
    }
}

fn normal_action_result_to_dto(result: NormalMessageActionResult) -> MessageLocalActionDto {
    MessageLocalActionDto {
        message_id: result.message_id,
        changed: result.changed,
        status: result.status,
        remote_applied: result.remote_applied,
    }
}

fn send_message_result_to_dto(result: SendMessageResult) -> SendMessageDto {
    SendMessageDto {
        message_id: result.message.id,
        queue_id: result.queue.id,
        status: result.queue.status,
    }
}

fn send_queue_row_to_dto(row: SendQueueRow) -> SendQueueDto {
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

fn contact_row_to_dto(row: ContactRow) -> ContactDto {
    ContactDto {
        id: row.id,
        display_name: row.display_name,
        email_address: row.email_address,
        note: row.note,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn agent_service_row_to_dto(row: AgentServiceRow) -> AgentServiceDto {
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

fn agent_thread_row_to_dto(row: AgentThreadRow) -> AgentThreadDto {
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

fn agent_message_row_to_dto(row: AgentMessageRow) -> AgentMessageDto {
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

fn agent_thread_detail_to_dto(detail: AgentThreadDetail) -> AgentThreadDetailDto {
    AgentThreadDetailDto {
        thread: agent_thread_row_to_dto(detail.thread),
        messages: detail
            .messages
            .into_iter()
            .map(agent_message_row_to_dto)
            .collect(),
    }
}

fn agent_send_task_result_to_dto(result: AgentSendTaskResult) -> AgentSendTaskDto {
    AgentSendTaskDto {
        thread: agent_thread_row_to_dto(result.thread),
        agent_message: agent_message_row_to_dto(result.agent_message),
        queue_id: result.queue.id,
        queue_status: result.queue.status,
    }
}

fn anonymous_message_row_to_dto(row: AnonymousMessageRow) -> AnonymousMessageDto {
    AnonymousMessageDto {
        message_id: row.message_id,
        thread_key: None,
        temp_mailbox_id: row.temp_mailbox_id,
        received_address: row.received_address,
        provider_label: row.provider_label,
        subject: row.subject,
        from_address: row.from_address,
        snippet: row.snippet,
        observed_at: row.observed_at,
        lifecycle_state: row.lifecycle_state,
        is_read: row.local_state.is_read,
        is_starred: row.local_state.is_starred,
        is_archived: row.local_state.is_archived,
        is_important: row.local_state.is_important,
        local_folder: row.local_state.local_folder,
        labels: row.local_state.labels,
        newsletter_subscription_id: row.local_state.newsletter_subscription_id,
    }
}

fn normal_message_row_to_dto(row: NormalAccountMessageRow) -> AnonymousMessageDto {
    AnonymousMessageDto {
        message_id: row.message_id,
        thread_key: row.thread_key,
        temp_mailbox_id: String::new(),
        received_address: row.received_address,
        provider_label: row.provider_label,
        subject: row.subject,
        from_address: row.from_address,
        snippet: row.snippet,
        observed_at: row.observed_at,
        lifecycle_state: "normal".to_string(),
        is_read: row.local_state.is_read,
        is_starred: row.local_state.is_starred,
        is_archived: row.local_state.is_archived,
        is_important: row.local_state.is_important,
        local_folder: row.local_state.local_folder,
        labels: row.local_state.labels,
        newsletter_subscription_id: row.local_state.newsletter_subscription_id,
    }
}

fn newsletter_subscription_row_to_dto(row: NewsletterSubscriptionRow) -> NewsletterSubscriptionDto {
    NewsletterSubscriptionDto {
        id: row.id,
        list_id: row.list_id,
        sender_address: row.sender_address,
        name: row.name,
        received_message_count: row.received_message_count,
        unread_message_count: row.unread_message_count,
        last_received_at: row.last_received_at,
        unsubscribe_methods: row.unsubscribe_methods,
        spam: row.spam,
        hidden: row.hidden,
    }
}

fn mail_taxonomy_row_to_dto(row: MailTaxonomyItemRow) -> MailTaxonomyItemDto {
    MailTaxonomyItemDto {
        id: row.id,
        kind: row.kind,
        name: row.name,
        parent_id: row.parent_id,
        color: row.color,
        sort_order: row.sort_order,
        system: row.system,
    }
}

fn sanitize_mail_taxonomy_parent_id(
    connection: &rusqlite::Connection,
    parent_id: &Option<String>,
) -> Result<Option<String>, ErrorDto> {
    let Some(parent_id) = parent_id.as_deref() else {
        return Ok(None);
    };
    let parent_id = parent_id.trim();
    if parent_id.is_empty() {
        return Ok(None);
    }
    let parent = get_mail_taxonomy_item(connection, parent_id)
        .map_err(message_list_error)?
        .ok_or_else(|| mail_taxonomy_not_found(parent_id))?;
    if parent.kind != "folder" {
        return Err(mail_taxonomy_validation_error(
            "mail_taxonomy_parent_kind_invalid",
            "Parent folder must be a folder.",
        ));
    }
    Ok(Some(parent.id))
}

fn validate_mail_taxonomy_parent_folder(
    connection: &rusqlite::Connection,
    parent_id: Option<&str>,
    item_id: &str,
) -> Result<(), ErrorDto> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    if parent_id == item_id {
        return Err(mail_taxonomy_validation_error(
            "mail_taxonomy_parent_cycle",
            "A folder cannot contain itself.",
        ));
    }
    let mut current = Some(parent_id.to_string());
    while let Some(current_id) = current {
        if current_id == item_id {
            return Err(mail_taxonomy_validation_error(
                "mail_taxonomy_parent_cycle",
                "A folder cannot contain itself.",
            ));
        }
        current = get_mail_taxonomy_item(connection, &current_id)
            .map_err(message_list_error)?
            .and_then(|parent| parent.parent_id);
    }
    Ok(())
}

fn mail_taxonomy_validation_error(code: &str, user_message: &str) -> ErrorDto {
    AppError {
        code: code.to_string(),
        category: ErrorCategory::Validation,
        user_message: user_message.to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}

fn promoted_message_row_to_dto(row: PromotedAccountMessageRow) -> AnonymousMessageDto {
    AnonymousMessageDto {
        message_id: row.message_id,
        thread_key: None,
        temp_mailbox_id: row.temp_mailbox_id,
        received_address: row.received_address,
        provider_label: row.provider_label,
        subject: row.subject,
        from_address: row.from_address,
        snippet: row.snippet,
        observed_at: row.observed_at,
        lifecycle_state: row.lifecycle_state,
        is_read: row.local_state.is_read,
        is_starred: row.local_state.is_starred,
        is_archived: row.local_state.is_archived,
        is_important: row.local_state.is_important,
        local_folder: row.local_state.local_folder,
        labels: row.local_state.labels,
        newsletter_subscription_id: row.local_state.newsletter_subscription_id,
    }
}

fn normal_message_detail_to_dto(row: NormalMessageDetailRow) -> MessageDetailDto {
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

fn smtp_source_missing_for_draft(account_id: &str) -> ErrorDto {
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

fn verification_code_row_to_dto(row: RecentVerificationCodeRow) -> VerificationCodeDto {
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

fn verification_poll_result_to_dto(result: VerificationPollResult) -> VerificationPollDto {
    VerificationPollDto {
        refresh: refresh_result_to_dto(result.refresh),
        detected_code: result.detected_code.map(verification_code_row_to_dto),
    }
}

fn enum_to_dto<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "unknown".to_string())
}

fn optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

fn lock_error(
    err: std::sync::PoisonError<std::sync::MutexGuard<'_, rusqlite::Connection>>,
) -> ErrorDto {
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
}

fn contact_storage_error(err: rusqlite::Error) -> ErrorDto {
    AppError {
        code: "contact_storage_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Contacts could not be loaded or updated.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}

fn agent_storage_error(err: rusqlite::Error) -> ErrorDto {
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

fn message_list_error(err: rusqlite::Error) -> ErrorDto {
    AppError {
        code: "message_list_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Messages could not be loaded.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}

fn message_action_error(err: rusqlite::Error) -> ErrorDto {
    AppError {
        code: "message_action_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "The selected message action could not be saved locally.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}

fn send_queue_list_error(err: rusqlite::Error) -> ErrorDto {
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

fn message_flag_unsupported(flag_name: &str) -> ErrorDto {
    AppError {
        code: "message_flag_unsupported".to_string(),
        category: ErrorCategory::Validation,
        user_message: "This local message flag is not supported.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "flag_name": flag_name })),
    }
    .to_dto()
}

fn message_folder_unsupported(folder_name: &str) -> ErrorDto {
    AppError {
        code: "message_folder_unsupported".to_string(),
        category: ErrorCategory::Validation,
        user_message: "This local message folder is not supported.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "folder_name": folder_name })),
    }
    .to_dto()
}

fn message_label_invalid(label_name: &str) -> ErrorDto {
    AppError {
        code: "message_label_invalid".to_string(),
        category: ErrorCategory::Validation,
        user_message: "This local message label is not valid.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "label_name": label_name })),
    }
    .to_dto()
}

fn mail_taxonomy_not_found(item_id: &str) -> ErrorDto {
    AppError {
        code: "mail_taxonomy_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected folder or label no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "id": item_id })),
    }
    .to_dto()
}

fn agent_thread_detail_not_found(thread_id: &str) -> ErrorDto {
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

fn promoted_account_id_required(scope: &str) -> ErrorDto {
    AppError {
        code: "promoted_account_id_required".to_string(),
        category: ErrorCategory::Validation,
        user_message: "Select a promoted account before loading promoted mailbox history."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "scope": scope })),
    }
    .to_dto()
}

fn normal_account_id_required(scope: &str) -> ErrorDto {
    AppError {
        code: "normal_account_id_required".to_string(),
        category: ErrorCategory::Validation,
        user_message: "Select a normal IMAP account before loading normal mailbox messages."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "scope": scope })),
    }
    .to_dto()
}

fn message_detail_not_found(message_id: &str) -> ErrorDto {
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

fn scheduled_send_not_pending(message_id: &str) -> ErrorDto {
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

fn message_scope_unsupported(scope: String) -> ErrorDto {
    AppError {
        code: "message_scope_unsupported".to_string(),
        category: ErrorCategory::Unsupported,
        user_message:
            "Only anonymous, promoted-account, and normal-account message scopes are available in this build."
                .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "scope": scope })),
    }
    .to_dto()
}

fn normalize_taxonomy_kind(kind: &str) -> Result<String, ErrorDto> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "folder" => Ok("folder".to_string()),
        "label" => Ok("label".to_string()),
        _ => Err(ErrorDto {
            code: "mail_taxonomy_kind_unsupported".to_string(),
            category: ErrorCategory::Validation,
            user_message: "Folder or label type is not supported.".to_string(),
            technical_message: Some(format!("Unsupported taxonomy kind: {kind}")),
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: "local-validation".to_string(),
            metadata: Box::new(serde_json::json!({ "kind": kind })),
        }),
    }
}

#[cfg(test)]
mod tests {
    use crate::services::easyemail_service::TempRefreshResult;
    use crate::services::verification_service::VerificationPollResult;
    use crate::storage::account_repository::AccountRow;
    use crate::storage::agent_repository::{AgentMessageRow, AgentThreadDetail, AgentThreadRow};
    use crate::storage::message_repository::{AnonymousMessageRow, NormalMessageDetailRow};
    use crate::storage::send_queue_repository::SendQueueRow;
    use crate::storage::temp_mailbox_repository::TempMailboxRow;
    use crate::storage::verification_repository::RecentVerificationCodeRow;

    use super::*;

    #[test]
    fn temp_mailbox_row_maps_to_command_dto() {
        let row = TempMailboxRow {
            id: "temp_1".to_string(),
            email_address: "code@example.test".to_string(),
            provider_id: "mailtm".to_string(),
            provider_label: "Mail.tm".to_string(),
            domain: Some("example.test".to_string()),
            local_part: Some("code".to_string()),
            easyemail_mailbox_id: Some("session_1".to_string()),
            source_id: Some("src_1".to_string()),
            visibility_state: "anonymous".to_string(),
            lifecycle_state: "active".to_string(),
            lease_expires_at: Some("2026-06-12T01:00:00Z".to_string()),
            upgraded_account_id: None,
            raw_provider_snapshot_json: "{\"safe\":true}".to_string(),
            created_at: "2026-06-12T00:00:00Z".to_string(),
            updated_at: "2026-06-12T00:00:00Z".to_string(),
        };

        let dto = temp_mailbox_row_to_dto(row);

        assert_eq!(dto.id, "temp_1");
        assert_eq!(dto.email_address, "code@example.test");
        assert_eq!(dto.provider_id, "mailtm");
        assert_eq!(dto.provider_label, "Mail.tm");
        assert_eq!(dto.visibility_state, "anonymous");
        assert_eq!(dto.easyemail_mailbox_id, Some("session_1".to_string()));
    }

    #[test]
    fn anonymous_message_row_maps_to_command_dto() {
        let row = AnonymousMessageRow {
            message_id: "msg_1".to_string(),
            temp_mailbox_id: "temp_1".to_string(),
            received_address: "code@example.test".to_string(),
            provider_label: "Mail.tm".to_string(),
            subject: "Your code is 123456".to_string(),
            from_address: "noreply@example.test".to_string(),
            snippet: "Use 123456 to continue.".to_string(),
            observed_at: "2026-06-12T00:10:00Z".to_string(),
            lifecycle_state: "active".to_string(),
            local_state: message_local_state_for_test(),
        };

        let dto = anonymous_message_row_to_dto(row);

        assert_eq!(dto.message_id, "msg_1");
        assert_eq!(dto.received_address, "code@example.test");
        assert_eq!(dto.provider_label, "Mail.tm");
        assert_eq!(dto.subject, "Your code is 123456");
        assert!(dto.is_read);
        assert_eq!(dto.local_folder, "inbox");
        assert_eq!(dto.labels, vec!["Follow up".to_string()]);
    }

    #[test]
    fn refresh_result_maps_to_command_dto() {
        let result = TempRefreshResult {
            fetched_count: 3,
            inserted_count: 2,
            skipped_count: 1,
            refreshed_mailbox_ids: vec!["temp_1".to_string()],
            skipped_mailbox_ids: vec!["temp_2".to_string()],
        };

        let dto = refresh_result_to_dto(result);

        assert_eq!(dto.fetched_count, 3);
        assert_eq!(dto.inserted_count, 2);
        assert_eq!(dto.skipped_count, 1);
        assert_eq!(dto.refreshed_mailbox_ids, vec!["temp_1".to_string()]);
        assert_eq!(dto.skipped_mailbox_ids, vec!["temp_2".to_string()]);
    }

    #[test]
    fn verification_code_row_maps_to_command_dto() {
        let row = recent_code_row_for_test();

        let dto = verification_code_row_to_dto(row);

        assert_eq!(dto.code, "123456");
        assert_eq!(dto.message_id, "msg_1");
        assert_eq!(dto.temp_mailbox_id, Some("temp_1".to_string()));
        assert_eq!(dto.received_address, "code@example.test");
        assert_eq!(dto.source_id, "src_1");
    }

    #[test]
    fn verification_poll_result_maps_to_command_dto() {
        let result = VerificationPollResult {
            refresh: TempRefreshResult {
                fetched_count: 1,
                inserted_count: 1,
                skipped_count: 0,
                refreshed_mailbox_ids: vec!["temp_1".to_string()],
                skipped_mailbox_ids: Vec::new(),
            },
            detected_code: Some(recent_code_row_for_test()),
        };

        let dto = verification_poll_result_to_dto(result);

        assert_eq!(dto.refresh.inserted_count, 1);
        assert_eq!(dto.detected_code.expect("code").code, "123456");
    }

    #[test]
    fn temp_upgrade_returns_account_and_mailbox_dtos() {
        let result = PromoteTempMailboxResult {
            account: account_row_for_test(),
            mailbox: temp_mailbox_row_for_test(),
        };

        let dto = promote_result_to_dto(result);

        assert_eq!(dto.account.kind, "normal_upgraded_temp");
        assert_eq!(dto.mailbox.visibility_state, "upgraded");
    }

    #[test]
    fn normal_message_detail_does_not_expose_secret_metadata() {
        let detail = NormalMessageDetailRow {
            message_id: "msg_1".to_string(),
            account_id: "acct_1".to_string(),
            thread_key: Some("rfc:root@example.test".to_string()),
            received_address: "user@example.test".to_string(),
            subject: "Welcome".to_string(),
            from_address: "noreply@example.test".to_string(),
            snippet: "Hello".to_string(),
            observed_at: "2026-06-12T00:10:00Z".to_string(),
            body_text: Some("Hello".to_string()),
            body_html: None,
            body_cache_state: "cached".to_string(),
            draft_cc_addresses: Vec::new(),
            draft_bcc_addresses: Vec::new(),
            credential_ref_id: Some("cred_1".to_string()),
            secret_key: Some("secret://imap/account-1".to_string()),
            local_state: message_local_state_for_test(),
        };

        let dto = normal_message_detail_to_dto(detail);
        let serialized = serde_json::to_string(&dto).expect("serialize dto");

        assert!(!serialized.contains("secret://imap/account-1"));
        assert!(!serialized.contains("credential_ref_id"));
    }

    #[test]
    fn newsletter_subscription_row_maps_to_command_dto() {
        let dto = newsletter_subscription_row_to_dto(NewsletterSubscriptionRow {
            id: "list:example".to_string(),
            list_id: "Example <example.test>".to_string(),
            sender_address: "Example <updates@example.test>".to_string(),
            name: "Example".to_string(),
            received_message_count: 3,
            unread_message_count: 1,
            last_received_at: "2026-06-12T00:20:00Z".to_string(),
            unsubscribe_methods: vec!["<mailto:unsubscribe@example.test>".to_string()],
            spam: false,
            hidden: false,
        });

        assert_eq!(dto.id, "list:example");
        assert_eq!(dto.name, "Example");
        assert_eq!(dto.received_message_count, 3);
        assert_eq!(dto.unread_message_count, 1);
        assert_eq!(
            dto.unsubscribe_methods,
            vec!["<mailto:unsubscribe@example.test>".to_string()]
        );
    }

    #[test]
    fn newsletter_subscription_action_dto_reports_hidden_state() {
        let dto = NewsletterSubscriptionActionDto {
            account_id: "acct_1".to_string(),
            subscription_id: "list:example".to_string(),
            hidden: true,
            changed: true,
        };

        assert_eq!(dto.account_id, "acct_1");
        assert_eq!(dto.subscription_id, "list:example");
        assert!(dto.hidden);
        assert!(dto.changed);
    }

    #[test]
    fn mail_taxonomy_row_maps_to_command_dto() {
        let dto = mail_taxonomy_row_to_dto(MailTaxonomyItemRow {
            id: "mailtax_label_client".to_string(),
            kind: "label".to_string(),
            name: "Client".to_string(),
            parent_id: None,
            color: "#06b6d4".to_string(),
            sort_order: 10,
            system: false,
            created_at: "2026-06-17T20:00:00Z".to_string(),
            updated_at: "2026-06-17T20:00:00Z".to_string(),
        });

        assert_eq!(dto.id, "mailtax_label_client");
        assert_eq!(dto.kind, "label");
        assert_eq!(dto.name, "Client");
        assert_eq!(dto.parent_id, None);
        assert_eq!(dto.color, "#06b6d4");
        assert!(!dto.system);
    }

    #[test]
    fn normal_message_row_dto_exposes_newsletter_subscription_id() {
        let mut row = normal_account_message_row_for_test();
        row.local_state.newsletter_subscription_id = Some("list:example".to_string());

        let dto = normal_message_row_to_dto(row);

        assert_eq!(
            dto.newsletter_subscription_id,
            Some("list:example".to_string())
        );
    }

    #[test]
    fn send_queue_row_dto_does_not_expose_secret_metadata() {
        let row = SendQueueRow {
            id: "send_1".to_string(),
            account_id: "acct_send".to_string(),
            source_id: "src_smtp".to_string(),
            message_id: "msg_outgoing".to_string(),
            target_address: "target@example.test".to_string(),
            cc_addresses: vec!["cc@example.test".to_string()],
            bcc_addresses: vec!["bcc@example.test".to_string()],
            subject: "Hello".to_string(),
            status: "queued".to_string(),
            attempt_count: 0,
            next_retry_at: None,
            last_error_code: None,
            last_error_message: None,
            created_at: "2026-06-12T01:00:00Z".to_string(),
            updated_at: "2026-06-12T01:00:00Z".to_string(),
            sent_at: None,
            credential_ref_id: Some("cred_1".to_string()),
            secret_key: Some("secret://smtp/account-1".to_string()),
        };

        let dto = send_queue_row_to_dto(row);
        let serialized = serde_json::to_string(&dto).expect("serialize dto");

        assert!(!serialized.contains("secret://smtp/account-1"));
        assert!(!serialized.contains("credential_ref_id"));
        assert!(serialized.contains("cc@example.test"));
        assert!(serialized.contains("bcc@example.test"));
    }

    #[test]
    fn agent_thread_detail_dto_does_not_expose_secret_metadata() {
        let detail = AgentThreadDetail {
            thread: AgentThreadRow {
                id: "agthread_1".to_string(),
                agent_service_id: "agsvc_1".to_string(),
                sender_account_id: "acct_agent".to_string(),
                subject: "Research task".to_string(),
                status: "awaiting_reply".to_string(),
                last_outgoing_message_id: Some("msg_outgoing".to_string()),
                last_incoming_message_id: None,
                correlation_key: "corr_1".to_string(),
                created_at: "2026-06-12T02:20:00Z".to_string(),
                updated_at: "2026-06-12T02:20:00Z".to_string(),
                completed_at: None,
            },
            messages: vec![AgentMessageRow {
                id: "agmsg_1".to_string(),
                thread_id: "agthread_1".to_string(),
                message_id: "msg_outgoing".to_string(),
                direction: "outgoing".to_string(),
                semantic_role: "task_request".to_string(),
                parsed_status: Some("queued".to_string()),
                parsed_payload_json: "{\"secret_key\":\"secret://smtp/acct_agent\"}".to_string(),
                created_at: "2026-06-12T02:20:00Z".to_string(),
            }],
        };

        let dto = agent_thread_detail_to_dto(detail);
        let serialized = serde_json::to_string(&dto).expect("serialize dto");

        assert!(!serialized.contains("secret://smtp/acct_agent"));
        assert!(!serialized.contains("secret_key"));
    }

    fn account_row_for_test() -> AccountRow {
        AccountRow {
            id: "acct_1".to_string(),
            scope: "normal".to_string(),
            kind: "normal_upgraded_temp".to_string(),
            display_name: "code@example.test".to_string(),
            primary_address: Some("code@example.test".to_string()),
            provider_label: Some("Fake Provider".to_string()),
            status: "ready".to_string(),
            auth_status: "not_required".to_string(),
            receive_status: "enabled".to_string(),
            send_status: "unsupported".to_string(),
            listed_in_all_accounts: true,
        }
    }

    fn message_local_state_for_test() -> MessageLocalState {
        MessageLocalState {
            is_read: true,
            is_starred: false,
            is_archived: false,
            is_important: false,
            local_folder: "inbox".to_string(),
            labels: vec!["Follow up".to_string()],
            newsletter_subscription_id: None,
        }
    }

    fn normal_account_message_row_for_test() -> NormalAccountMessageRow {
        NormalAccountMessageRow {
            account_id: "acct_1".to_string(),
            message_id: "msg_1".to_string(),
            thread_key: Some("rfc:root@example.test".to_string()),
            source_id: "src_1".to_string(),
            folder_id: "folder_inbox".to_string(),
            provider_message_id: "uid_1".to_string(),
            received_address: "user@example.test".to_string(),
            provider_label: "Manual IMAP".to_string(),
            subject: "Newsletter".to_string(),
            from_address: "Updates <updates@example.test>".to_string(),
            snippet: "Update body".to_string(),
            observed_at: "2026-06-12T00:10:00Z".to_string(),
            local_state: message_local_state_for_test(),
        }
    }

    fn temp_mailbox_row_for_test() -> TempMailboxRow {
        TempMailboxRow {
            id: "temp_1".to_string(),
            email_address: "code@example.test".to_string(),
            provider_id: "fake".to_string(),
            provider_label: "Fake Provider".to_string(),
            domain: Some("example.test".to_string()),
            local_part: Some("code".to_string()),
            easyemail_mailbox_id: Some("session_1".to_string()),
            source_id: Some("src_1".to_string()),
            visibility_state: "upgraded".to_string(),
            lifecycle_state: "active".to_string(),
            lease_expires_at: None,
            upgraded_account_id: Some("acct_1".to_string()),
            raw_provider_snapshot_json: "{}".to_string(),
            created_at: "2026-06-12T00:00:00Z".to_string(),
            updated_at: "2026-06-12T00:20:00Z".to_string(),
        }
    }

    fn recent_code_row_for_test() -> RecentVerificationCodeRow {
        RecentVerificationCodeRow {
            id: "vcode_1".to_string(),
            message_id: "msg_1".to_string(),
            temp_mailbox_id: Some("temp_1".to_string()),
            source_id: "src_1".to_string(),
            account_scope: "anonymous".to_string(),
            received_address: "code@example.test".to_string(),
            code: "123456".to_string(),
            issuer_hint: Some("example.test".to_string()),
            target_service_hint: Some("github".to_string()),
            confidence: 0.95,
            expires_at: None,
            extracted_at: "2026-06-12T00:11:00Z".to_string(),
            subject: "Your code is 123456".to_string(),
            from_address: "noreply@example.test".to_string(),
            observed_at: "2026-06-12T00:10:00Z".to_string(),
        }
    }
}
