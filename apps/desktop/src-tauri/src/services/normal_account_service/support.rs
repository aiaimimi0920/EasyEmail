use super::*;

pub(super) fn imap_profile_and_secret<V: SecretVaultAdapter>(
    vault: &V,
    context: &ImapMessageActionContextRow,
) -> Result<(ImapConnectionProfile, String), AppError> {
    let secret = vault
        .load_secret(&context.secret_key)?
        .ok_or_else(|| imap_secret_missing(&context.account_id))?;
    Ok((
        ImapConnectionProfile {
            host: context.config.host.clone(),
            port: context.config.port,
            security: context.config.security.clone(),
            username: context.config.username.clone(),
        },
        secret,
    ))
}

pub(super) fn resolve_target_folder<A: ImapAdapter>(
    connection: &Connection,
    adapter: &A,
    profile: &ImapConnectionProfile,
    secret: &str,
    context: &ImapMessageActionContextRow,
    target_kind: &str,
    now: &str,
) -> Result<Option<MailFolderRow>, AppError> {
    let existing =
        list_mail_folders_for_source(connection, &context.source_id).map_err(storage_error)?;
    if let Some(folder) = find_folder_for_kind(&existing, target_kind) {
        return Ok(Some(folder));
    }

    let discovered = adapter.discover_folders(profile, secret)?;
    for folder in discovered {
        upsert_mail_folder(
            connection,
            &context.account_id,
            &context.source_id,
            &folder,
            now,
        )
        .map_err(storage_error)?;
    }
    let refreshed =
        list_mail_folders_for_source(connection, &context.source_id).map_err(storage_error)?;
    Ok(find_folder_for_kind(&refreshed, target_kind))
}

pub(super) fn find_folder_for_kind(
    folders: &[MailFolderRow],
    target_kind: &str,
) -> Option<MailFolderRow> {
    folders
        .iter()
        .find(|folder| folder.folder_kind == target_kind)
        .cloned()
        .or_else(|| {
            folders
                .iter()
                .find(|folder| folder_matches_kind(folder, target_kind))
                .cloned()
        })
}

pub(super) fn folder_matches_kind(folder: &MailFolderRow, target_kind: &str) -> bool {
    let aliases = match target_kind {
        "inbox" => &["inbox", "收件箱"][..],
        "archive" => &["archive", "archives", "归档", "已归档"][..],
        "spam" => &["spam", "junk", "junkemail", "垃圾邮件", "广告邮件"][..],
        "trash" => &[
            "trash",
            "deleted",
            "deletedmessages",
            "deleteditems",
            "bin",
            "已删除",
            "已删除邮件",
            "废件箱",
            "垃圾箱",
        ][..],
        _ => &[][..],
    };
    let values = [
        folder.folder_kind.as_str(),
        folder.display_name.as_str(),
        folder.path.as_str(),
        folder.provider_folder_id.as_str(),
    ];

    values.iter().any(|value| {
        let token = normalized_folder_token(value);
        aliases.iter().any(|alias| {
            let alias = normalized_folder_token(alias);
            token == alias || token.ends_with(&alias)
        })
    })
}

pub(super) fn normalized_folder_token(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '_' | '-'))
        .collect()
}

pub(super) fn context_folder_to_imap(context: &ImapMessageActionContextRow) -> ImapFolder {
    ImapFolder {
        provider_folder_id: context.folder_provider_id.clone(),
        display_name: context.folder_display_name.clone(),
        path: context.folder_path.clone(),
        delimiter: context
            .folder_delimiter
            .clone()
            .unwrap_or_else(|| "/".to_string()),
        folder_kind: context.folder_kind.clone(),
    }
}

pub(super) fn local_action_result(
    message_id: &str,
    changed: bool,
    status: impl Into<String>,
) -> NormalMessageActionResult {
    action_result(message_id, changed, false, status)
}

pub(super) fn remote_action_result(
    message_id: &str,
    changed: bool,
    status: impl Into<String>,
) -> NormalMessageActionResult {
    action_result(message_id, changed, true, status)
}

pub(super) fn action_result(
    message_id: &str,
    changed: bool,
    remote_applied: bool,
    status: impl Into<String>,
) -> NormalMessageActionResult {
    NormalMessageActionResult {
        message_id: message_id.to_string(),
        changed,
        remote_applied,
        status: status.into(),
    }
}

pub(super) fn folder_to_imap(folder: &MailFolderRow) -> ImapFolder {
    ImapFolder {
        provider_folder_id: folder.provider_folder_id.clone(),
        display_name: folder.display_name.clone(),
        path: folder.path.clone(),
        delimiter: folder.delimiter.clone().unwrap_or_else(|| "/".to_string()),
        folder_kind: folder.folder_kind.clone(),
    }
}

pub(super) fn imap_secret_missing(account_id: &str) -> AppError {
    AppError {
        code: "imap_secret_missing".to_string(),
        category: ErrorCategory::Storage,
        user_message: "The IMAP password reference exists but the secret could not be loaded."
            .to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::UnlockVault,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}

pub(super) fn storage_error(error: rusqlite::Error) -> AppError {
    AppError {
        code: "sqlite_normal_account_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Normal account state could not be updated.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}
