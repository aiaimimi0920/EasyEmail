use super::*;

pub(super) fn apply_archive_action<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    message_id: &str,
    enabled: bool,
    now: &str,
) -> Result<NormalMessageActionResult, AppError>
where
    V: SecretVaultAdapter,
    A: ImapAdapter,
{
    if !enabled {
        let changed = set_message_source_flag(connection, message_id, "archived", false, now)
            .map_err(storage_error)?;
        return Ok(local_action_result(message_id, changed, "archived_cleared"));
    }

    let Some(context) =
        get_imap_message_action_context(connection, message_id).map_err(storage_error)?
    else {
        let changed = set_message_source_flag(connection, message_id, "archived", true, now)
            .map_err(storage_error)?;
        return Ok(local_action_result(message_id, changed, "archived"));
    };

    let (profile, secret) = imap_profile_and_secret(vault, &context)?;
    let remote_applied = if let Some(target_folder) = resolve_target_folder(
        connection, adapter, &profile, &secret, &context, "archive", now,
    )? {
        if target_folder.path != context.folder_path {
            let move_result = adapter.move_message(
                &profile,
                &secret,
                &context_folder_to_imap(&context),
                &context.provider_message_id,
                &folder_to_imap(&target_folder),
            )?;
            set_message_source_remote_folder(
                connection,
                message_id,
                &context.source_id,
                &target_folder.id,
                move_result.provider_message_id.as_deref(),
                now,
            )
            .map_err(storage_error)?;
            true
        } else {
            false
        }
    } else {
        false
    };
    let changed = set_message_source_flag(connection, message_id, "archived", true, now)
        .map_err(storage_error)?;

    Ok(action_result(
        message_id,
        changed,
        remote_applied,
        if remote_applied {
            "remote_archived"
        } else {
            "archived"
        },
    ))
}

/// A move whose target folder was resolved from the local cache, so the IMAP
/// round trip can happen with no database lock held.
///
/// Deliberately not `Debug`: `secret` holds a decrypted mailbox credential.
/// The local write a planned move performs once its remote phase is done.
///
/// Archive and an explicit folder move share the same IMAP machinery and differ
/// only here, so one plan type serves both.
pub enum PlannedMoveEffect {
    SetFolder { folder_name: String },
    SetArchived { enabled: bool },
}

pub struct PlannedMove {
    message_id: String,
    effect: PlannedMoveEffect,
    source_id: String,
    profile: ImapConnectionProfile,
    secret: String,
    source_folder: ImapFolder,
    provider_message_id: String,
    target_folder_id: String,
    target_folder: ImapFolder,
    /// False when the message already sits in the target folder, in which case
    /// there is nothing to send.
    target_differs: bool,
}

/// What a move needs before it can run.
pub enum MovePlan {
    /// No remote work: only the local write happens.
    LocalOnly {
        message_id: String,
        effect: PlannedMoveEffect,
    },
    /// The target came from the local folder cache, so this is lock-free.
    Remote(Box<PlannedMove>),
    /// The target folder is not cached. Resolving it interleaves a network
    /// discovery with the database writes that assign folder ids, which cannot
    /// be expressed as one lock-free phase, so the caller must fall back to
    /// [`apply_move_action`] while holding its lock.
    ///
    /// Rare in practice: `sync_recent_headers` upserts discovered folders, so a
    /// synced account resolves from cache. See
    /// `move_action_on_a_synced_account_resolves_the_target_folder_without_discovery`.
    RequiresLockedFallback,
}

impl MovePlan {
    /// Whether this plan needs the lock-free IMAP phase.
    pub fn needs_remote(&self) -> bool {
        matches!(self, MovePlan::Remote(planned) if planned.target_differs)
    }

    /// Whether the caller must instead run the locked path.
    pub fn requires_locked_fallback(&self) -> bool {
        matches!(self, MovePlan::RequiresLockedFallback)
    }
}

/// Phase 1 of a move: normalize the target, load the credential, and try to
/// resolve the target folder from the local cache. Touches the database and the
/// secret vault, never the network.
pub fn plan_move_action<V>(
    connection: &Connection,
    vault: &V,
    message_id: &str,
    folder_name: &str,
) -> Result<MovePlan, AppError>
where
    V: SecretVaultAdapter,
{
    let folder_name = folder_name.trim().to_ascii_lowercase();
    let local_only = |folder_name: String| MovePlan::LocalOnly {
        message_id: message_id.to_string(),
        effect: PlannedMoveEffect::SetFolder { folder_name },
    };

    if folder_name == "later" {
        return Ok(local_only(folder_name));
    }

    let Some(remote_kind) = (match folder_name.as_str() {
        "inbox" => Some("inbox"),
        "spam" => Some("spam"),
        "trash" => Some("trash"),
        "archive" => Some("archive"),
        _ => None,
    }) else {
        return Ok(local_only(folder_name));
    };

    let Some(context) =
        get_imap_message_action_context(connection, message_id).map_err(storage_error)?
    else {
        return Ok(local_only(folder_name));
    };

    let cached_folders =
        list_mail_folders_for_source(connection, &context.source_id).map_err(storage_error)?;
    let Some(target_folder) = find_folder_for_kind(&cached_folders, remote_kind) else {
        return Ok(MovePlan::RequiresLockedFallback);
    };

    let (profile, secret) = imap_profile_and_secret(vault, &context)?;
    Ok(MovePlan::Remote(Box::new(PlannedMove {
        message_id: message_id.to_string(),
        effect: PlannedMoveEffect::SetFolder { folder_name },
        source_id: context.source_id.clone(),
        profile,
        secret,
        source_folder: context_folder_to_imap(&context),
        provider_message_id: context.provider_message_id.clone(),
        target_folder_id: target_folder.id.clone(),
        target_differs: target_folder.path != context.folder_path,
        target_folder: folder_to_imap(&target_folder),
    })))
}

/// Phase 2 of a move: the IMAP round trip. Takes no `&Connection`, so it cannot
/// hold the database lock.
pub fn fetch_planned_move<A>(
    adapter: &A,
    plan: &MovePlan,
) -> Result<Option<ImapMessageMoveResult>, AppError>
where
    A: ImapAdapter,
{
    let MovePlan::Remote(planned) = plan else {
        return Ok(None);
    };
    if !planned.target_differs {
        return Ok(None);
    }

    adapter
        .move_message(
            &planned.profile,
            &planned.secret,
            &planned.source_folder,
            &planned.provider_message_id,
            &planned.target_folder,
        )
        .map(Some)
}

/// Phase 3 of a move: record the new remote folder and the local folder column.
pub fn persist_planned_move(
    connection: &Connection,
    plan: MovePlan,
    move_result: Option<ImapMessageMoveResult>,
    now: &str,
) -> Result<NormalMessageActionResult, AppError> {
    let planned = match plan {
        MovePlan::LocalOnly { message_id, effect } => {
            let (changed, status) =
                apply_planned_move_effect(connection, &message_id, &effect, false, now)?;
            return Ok(local_action_result(&message_id, changed, status));
        }
        MovePlan::RequiresLockedFallback => {
            return Err(AppError::internal(
                "move_plan_requires_locked_fallback",
                "persist_planned_move was called for a plan that needs the locked path",
            ))
        }
        MovePlan::Remote(planned) => *planned,
    };

    let remote_applied = if let Some(move_result) = move_result {
        set_message_source_remote_folder(
            connection,
            &planned.message_id,
            &planned.source_id,
            &planned.target_folder_id,
            move_result.provider_message_id.as_deref(),
            now,
        )
        .map_err(storage_error)?;
        true
    } else {
        false
    };
    let (changed, status) = apply_planned_move_effect(
        connection,
        &planned.message_id,
        &planned.effect,
        remote_applied,
        now,
    )?;

    Ok(action_result(
        &planned.message_id,
        changed,
        remote_applied,
        status,
    ))
}

/// Performs a plan's local write and returns the status string that goes with it.
pub(super) fn apply_planned_move_effect(
    connection: &Connection,
    message_id: &str,
    effect: &PlannedMoveEffect,
    remote_applied: bool,
    now: &str,
) -> Result<(bool, String), AppError> {
    match effect {
        PlannedMoveEffect::SetFolder { folder_name } => {
            let changed = set_message_source_folder(connection, message_id, folder_name, now)
                .map_err(storage_error)?;
            let status = if remote_applied {
                format!("remote_folder:{folder_name}")
            } else {
                format!("folder:{folder_name}")
            };
            Ok((changed, status))
        }
        PlannedMoveEffect::SetArchived { enabled } => {
            let changed =
                set_message_source_flag(connection, message_id, "archived", *enabled, now)
                    .map_err(storage_error)?;
            let status = match (*enabled, remote_applied) {
                (false, _) => "archived_cleared".to_string(),
                (true, true) => "remote_archived".to_string(),
                (true, false) => "archived".to_string(),
            };
            Ok((changed, status))
        }
    }
}

/// Phase 1 of an archive, sharing the move machinery. Same lock discipline as
/// [`plan_move_action`]: database and vault only, never the network.
pub fn plan_archive_action<V>(
    connection: &Connection,
    vault: &V,
    message_id: &str,
    enabled: bool,
) -> Result<MovePlan, AppError>
where
    V: SecretVaultAdapter,
{
    let local_only = MovePlan::LocalOnly {
        message_id: message_id.to_string(),
        effect: PlannedMoveEffect::SetArchived { enabled },
    };

    // Un-archiving only clears the local flag; there is nothing to move back to.
    if !enabled {
        return Ok(local_only);
    }

    let Some(context) =
        get_imap_message_action_context(connection, message_id).map_err(storage_error)?
    else {
        return Ok(local_only);
    };

    let cached_folders =
        list_mail_folders_for_source(connection, &context.source_id).map_err(storage_error)?;
    let Some(target_folder) = find_folder_for_kind(&cached_folders, "archive") else {
        return Ok(MovePlan::RequiresLockedFallback);
    };

    let (profile, secret) = imap_profile_and_secret(vault, &context)?;
    Ok(MovePlan::Remote(Box::new(PlannedMove {
        message_id: message_id.to_string(),
        effect: PlannedMoveEffect::SetArchived { enabled },
        source_id: context.source_id.clone(),
        profile,
        secret,
        source_folder: context_folder_to_imap(&context),
        provider_message_id: context.provider_message_id.clone(),
        target_folder_id: target_folder.id.clone(),
        target_differs: target_folder.path != context.folder_path,
        target_folder: folder_to_imap(&target_folder),
    })))
}
pub(super) fn apply_move_action<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    message_id: &str,
    folder_name: &str,
    now: &str,
) -> Result<NormalMessageActionResult, AppError>
where
    V: SecretVaultAdapter,
    A: ImapAdapter,
{
    let folder_name = folder_name.trim().to_ascii_lowercase();
    if folder_name == "later" {
        let changed = set_message_source_folder(connection, message_id, &folder_name, now)
            .map_err(storage_error)?;
        return Ok(local_action_result(
            message_id,
            changed,
            format!("folder:{folder_name}"),
        ));
    }

    let Some(remote_kind) = (match folder_name.as_str() {
        "inbox" => Some("inbox"),
        "spam" => Some("spam"),
        "trash" => Some("trash"),
        "archive" => Some("archive"),
        _ => None,
    }) else {
        let changed = set_message_source_folder(connection, message_id, &folder_name, now)
            .map_err(storage_error)?;
        return Ok(local_action_result(
            message_id,
            changed,
            format!("folder:{folder_name}"),
        ));
    };

    let Some(context) =
        get_imap_message_action_context(connection, message_id).map_err(storage_error)?
    else {
        let changed = set_message_source_folder(connection, message_id, &folder_name, now)
            .map_err(storage_error)?;
        return Ok(local_action_result(
            message_id,
            changed,
            format!("folder:{folder_name}"),
        ));
    };

    let (profile, secret) = imap_profile_and_secret(vault, &context)?;
    let remote_applied = if let Some(target_folder) = resolve_target_folder(
        connection,
        adapter,
        &profile,
        &secret,
        &context,
        remote_kind,
        now,
    )? {
        if target_folder.path != context.folder_path {
            let move_result = adapter.move_message(
                &profile,
                &secret,
                &context_folder_to_imap(&context),
                &context.provider_message_id,
                &folder_to_imap(&target_folder),
            )?;
            set_message_source_remote_folder(
                connection,
                message_id,
                &context.source_id,
                &target_folder.id,
                move_result.provider_message_id.as_deref(),
                now,
            )
            .map_err(storage_error)?;
            true
        } else {
            false
        }
    } else {
        false
    };
    let changed = set_message_source_folder(connection, message_id, &folder_name, now)
        .map_err(storage_error)?;

    Ok(action_result(
        message_id,
        changed,
        remote_applied,
        if remote_applied {
            format!("remote_folder:{folder_name}")
        } else {
            format!("folder:{folder_name}")
        },
    ))
}

pub(super) fn apply_delete_action<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    message_id: &str,
    now: &str,
) -> Result<NormalMessageActionResult, AppError>
where
    V: SecretVaultAdapter,
    A: ImapAdapter,
{
    let mut result = apply_move_action(connection, vault, adapter, message_id, "trash", now)?;
    result.status = if result.remote_applied {
        "remote_deleted_to_trash".to_string()
    } else {
        "deleted_to_trash".to_string()
    };
    Ok(result)
}

/// Deletes a message permanently, end to end.
///
/// Prefer the phased trio ([`plan_permanent_delete_action`],
/// [`push_planned_remote_flag`], [`persist_planned_remote_flag`]) from command
/// handlers: this entry point performs an IMAP round trip, and the caller's
/// database lock would be held for its whole duration.
pub(super) fn apply_permanent_delete_action<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    message_id: &str,
    now: &str,
) -> Result<NormalMessageActionResult, AppError>
where
    V: SecretVaultAdapter,
    A: ImapAdapter,
{
    let plan = plan_permanent_delete_action(connection, vault, message_id)?;
    push_planned_remote_flag(adapter, &plan)?;
    persist_planned_remote_flag(connection, plan, now)
}
