use super::*;

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

pub(super) fn mail_taxonomy_row_to_dto(row: MailTaxonomyItemRow) -> MailTaxonomyItemDto {
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

pub(super) fn sanitize_mail_taxonomy_parent_id(
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

pub(super) fn validate_mail_taxonomy_parent_folder(
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

pub(super) fn mail_taxonomy_validation_error(code: &str, user_message: &str) -> ErrorDto {
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

pub(super) fn mail_taxonomy_not_found(item_id: &str) -> ErrorDto {
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

pub(super) fn normalize_taxonomy_kind(kind: &str) -> Result<String, ErrorDto> {
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
