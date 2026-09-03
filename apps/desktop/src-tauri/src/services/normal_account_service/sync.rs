use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncRecentHeadersRequest {
    pub account_id: String,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncRecentHeadersResult {
    pub account_id: String,
    pub fetched_count: usize,
    pub inserted_count: usize,
    pub folder_id: String,
}

pub fn sync_recent_headers<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    request: SyncRecentHeadersRequest,
    now: String,
) -> Result<SyncRecentHeadersResult, AppError>
where
    V: SecretVaultAdapter,
    A: ImapAdapter,
{
    let source = get_normal_imap_source_for_account(connection, &request.account_id)
        .map_err(storage_error)?
        .ok_or_else(|| normal_imap_account_not_found(&request.account_id))?;
    let secret = vault
        .load_secret(&source.secret_key)?
        .ok_or_else(|| imap_secret_missing(&source.account.id))?;
    let profile = ImapConnectionProfile {
        host: source.config.host,
        port: source.config.port,
        security: source.config.security,
        username: source.config.username,
    };
    let primary_folder = ensure_sync_folder(
        connection,
        adapter,
        &profile,
        &secret,
        &source.account.id,
        &source.source_id,
        &now,
    )?;
    let limit = request.limit.clamp(1, 100);
    let folders = sync_recent_header_folders(SyncRecentHeaderFoldersContext {
        connection,
        adapter,
        profile: &profile,
        secret: &secret,
        account_id: &source.account.id,
        source_id: &source.source_id,
        primary_folder: &primary_folder,
        now: &now,
    })?;
    let mut fetched_count = 0;
    let mut inserted_count = 0;
    let mut inserted_message_ids = Vec::new();
    for folder in &folders {
        let headers =
            adapter.fetch_recent_headers(&profile, &secret, &folder_to_imap(folder), limit)?;
        let persisted: PersistObservedMessagesResult = persist_imap_headers(
            connection,
            &source.account.id,
            &source.source_id,
            &folder.id,
            &headers,
            &now,
        )
        .map_err(storage_error)?;
        fetched_count += persisted.fetched_count;
        inserted_count += persisted.inserted_count;
        inserted_message_ids.extend(persisted.inserted_message_ids);
    }
    crate::services::verification_service::classify_new_messages(
        connection,
        &inserted_message_ids,
        &now,
    )?;
    mark_imap_source_sync_success(connection, &source.source_id, &now).map_err(storage_error)?;

    Ok(SyncRecentHeadersResult {
        account_id: source.account.id,
        fetched_count,
        inserted_count,
        folder_id: primary_folder.id,
    })
}

pub(super) fn ensure_sync_folder<A: ImapAdapter>(
    connection: &Connection,
    adapter: &A,
    profile: &ImapConnectionProfile,
    secret: &str,
    account_id: &str,
    source_id: &str,
    now: &str,
) -> Result<MailFolderRow, AppError> {
    let existing_folders =
        list_mail_folders_for_source(connection, source_id).map_err(storage_error)?;
    if let Some(folder) = choose_inbox_folder(existing_folders) {
        return Ok(folder);
    }

    let discovered = adapter.discover_folders(profile, secret)?;
    let mut stored = Vec::new();
    for folder in discovered {
        stored.push(
            upsert_mail_folder(connection, account_id, source_id, &folder, now)
                .map_err(storage_error)?,
        );
    }
    choose_inbox_folder(stored).ok_or_else(|| imap_inbox_missing(account_id))
}

pub(super) fn choose_inbox_folder(folders: Vec<MailFolderRow>) -> Option<MailFolderRow> {
    folders
        .iter()
        .find(|folder| folder.folder_kind == "inbox" || folder.path.eq_ignore_ascii_case("inbox"))
        .cloned()
        .or_else(|| folders.into_iter().next())
}

struct SyncRecentHeaderFoldersContext<'a, A> {
    connection: &'a Connection,
    adapter: &'a A,
    profile: &'a ImapConnectionProfile,
    secret: &'a str,
    account_id: &'a str,
    source_id: &'a str,
    primary_folder: &'a MailFolderRow,
    now: &'a str,
}

fn sync_recent_header_folders<A: ImapAdapter>(
    context: SyncRecentHeaderFoldersContext<'_, A>,
) -> Result<Vec<MailFolderRow>, AppError> {
    let SyncRecentHeaderFoldersContext {
        connection,
        adapter,
        profile,
        secret,
        account_id,
        source_id,
        primary_folder,
        now,
    } = context;
    let mut stored = list_mail_folders_for_source(connection, source_id).map_err(storage_error)?;
    if !stored.iter().any(|folder| folder.folder_kind == "spam") {
        let discovered = adapter.discover_folders(profile, secret)?;
        for folder in discovered {
            upsert_mail_folder(connection, account_id, source_id, &folder, now)
                .map_err(storage_error)?;
        }
        stored = list_mail_folders_for_source(connection, source_id).map_err(storage_error)?;
    }

    let mut folders = stored
        .into_iter()
        .filter(|folder| matches!(folder.folder_kind.as_str(), "inbox" | "spam"))
        .collect::<Vec<_>>();
    if !folders.iter().any(|folder| folder.id == primary_folder.id) {
        folders.push(primary_folder.clone());
    }
    folders.sort_by_key(|folder| {
        if folder.id == primary_folder.id {
            0
        } else if folder.folder_kind == "spam" {
            1
        } else {
            2
        }
    });
    folders.dedup_by(|left, right| left.id == right.id);
    Ok(folders)
}

pub(super) fn normal_imap_account_not_found(account_id: &str) -> AppError {
    AppError {
        code: "normal_imap_account_not_found".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected normal IMAP account no longer exists.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}

pub(super) fn imap_inbox_missing(account_id: &str) -> AppError {
    AppError {
        code: "imap_inbox_missing".to_string(),
        category: ErrorCategory::Protocol,
        user_message: "The IMAP account did not expose a folder that can be synced.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}
