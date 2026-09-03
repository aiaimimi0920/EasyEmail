use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalMessageAction {
    SetRead(bool),
    SetStarred(bool),
    SetArchived(bool),
    MoveTo(String),
    Delete,
    DeleteForever,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalMessageActionRequest {
    pub message_id: String,
    pub action: NormalMessageAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalMessageActionResult {
    pub message_id: String,
    pub changed: bool,
    pub remote_applied: bool,
    pub status: String,
}

pub fn apply_normal_message_action<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    request: NormalMessageActionRequest,
    now: String,
) -> Result<NormalMessageActionResult, AppError>
where
    V: SecretVaultAdapter,
    A: ImapAdapter,
{
    let message_id = request.message_id.trim().to_string();
    if message_id.is_empty() {
        return Err(normal_message_action_invalid());
    }

    match request.action {
        NormalMessageAction::SetRead(enabled) => apply_remote_flag_action(
            connection,
            vault,
            adapter,
            &message_id,
            RemoteFlagKind::Read,
            enabled,
            &now,
        ),
        NormalMessageAction::SetStarred(enabled) => apply_remote_flag_action(
            connection,
            vault,
            adapter,
            &message_id,
            RemoteFlagKind::Starred,
            enabled,
            &now,
        ),
        NormalMessageAction::SetArchived(enabled) => {
            apply_archive_action(connection, vault, adapter, &message_id, enabled, &now)
        }
        NormalMessageAction::MoveTo(folder_name) => {
            apply_move_action(connection, vault, adapter, &message_id, &folder_name, &now)
        }
        NormalMessageAction::Delete => {
            apply_delete_action(connection, vault, adapter, &message_id, &now)
        }
        NormalMessageAction::DeleteForever => {
            apply_permanent_delete_action(connection, vault, adapter, &message_id, &now)
        }
    }
}

pub(super) fn normal_message_action_invalid() -> AppError {
    AppError {
        code: "normal_message_action_invalid".to_string(),
        category: ErrorCategory::Validation,
        user_message: "The selected message action is not valid.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}
