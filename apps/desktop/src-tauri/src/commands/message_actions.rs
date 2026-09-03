use super::*;

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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MessageLocalActionDto {
    pub message_id: String,
    pub changed: bool,
    pub status: String,
    pub remote_applied: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MessageBatchActionDto {
    pub requested_count: usize,
    pub changed_count: usize,
    pub remote_applied_count: usize,
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

pub(super) fn normal_action_result_to_dto(
    result: NormalMessageActionResult,
) -> MessageLocalActionDto {
    MessageLocalActionDto {
        message_id: result.message_id,
        changed: result.changed,
        status: result.status,
        remote_applied: result.remote_applied,
    }
}

pub(super) fn message_flag_unsupported(flag_name: &str) -> ErrorDto {
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

pub(super) fn message_folder_unsupported(folder_name: &str) -> ErrorDto {
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
