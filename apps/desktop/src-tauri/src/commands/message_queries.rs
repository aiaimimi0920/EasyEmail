use super::*;

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

pub(super) fn anonymous_message_row_to_dto(row: AnonymousMessageRow) -> AnonymousMessageDto {
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

pub(super) fn normal_message_row_to_dto(row: NormalAccountMessageRow) -> AnonymousMessageDto {
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

pub(super) fn newsletter_subscription_row_to_dto(
    row: NewsletterSubscriptionRow,
) -> NewsletterSubscriptionDto {
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

pub(super) fn promoted_message_row_to_dto(row: PromotedAccountMessageRow) -> AnonymousMessageDto {
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

pub(super) fn promoted_account_id_required(scope: &str) -> ErrorDto {
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

pub(super) fn normal_account_id_required(scope: &str) -> ErrorDto {
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

pub(super) fn message_scope_unsupported(scope: String) -> ErrorDto {
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
