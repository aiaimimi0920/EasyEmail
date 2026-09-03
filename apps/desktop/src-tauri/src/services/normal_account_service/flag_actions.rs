use super::*;

/// Which IMAP-backed flag a phased flag action targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteFlagKind {
    Read,
    Starred,
}

impl RemoteFlagKind {
    fn local_flag_name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Starred => "starred",
        }
    }

    fn remote_flag(self) -> ImapMessageFlag {
        match self {
            Self::Read => ImapMessageFlag::Seen,
            Self::Starred => ImapMessageFlag::Flagged,
        }
    }
}

/// The local database write a plan performs once its remote phase is done.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlannedLocalEffect {
    SetFlag {
        local_flag_name: &'static str,
        enabled: bool,
    },
    SoftDelete,
}

/// The IMAP half of a plan: present only when the message has a remote source.
struct PlannedRemotePush {
    remote_flag: ImapMessageFlag,
    remote_enabled: bool,
    profile: ImapConnectionProfile,
    secret: String,
    folder: ImapFolder,
    provider_message_id: String,
}

/// The decided work for a message action, produced before any network call.
///
/// Opaque on purpose: it is only constructible through the `plan_*` functions, so
/// the phase ordering cannot be bypassed. Deliberately has no `Debug` derive, since
/// `remote` carries a decrypted mailbox secret.
pub struct RemoteFlagPlan {
    message_id: String,
    effect: PlannedLocalEffect,
    remote: Option<PlannedRemotePush>,
}

impl RemoteFlagPlan {
    /// Whether this plan still needs the lock-free IMAP phase. Lets a caller keep
    /// its lock when the action is purely local.
    pub fn needs_remote(&self) -> bool {
        self.remote.is_some()
    }
}

/// Phase 1 for a read/starred flag change. Touches the database and the secret
/// vault, never the network, so the caller can drop its lock afterward.
pub fn plan_remote_flag_action<V>(
    connection: &Connection,
    vault: &V,
    message_id: &str,
    kind: RemoteFlagKind,
    enabled: bool,
) -> Result<RemoteFlagPlan, AppError>
where
    V: SecretVaultAdapter,
{
    plan_remote_message_action(
        connection,
        vault,
        message_id,
        PlannedLocalEffect::SetFlag {
            local_flag_name: kind.local_flag_name(),
            enabled,
        },
        kind.remote_flag(),
        enabled,
    )
}

/// Phase 1 for a permanent delete. Same lock discipline as
/// [`plan_remote_flag_action`].
pub fn plan_permanent_delete_action<V>(
    connection: &Connection,
    vault: &V,
    message_id: &str,
) -> Result<RemoteFlagPlan, AppError>
where
    V: SecretVaultAdapter,
{
    plan_remote_message_action(
        connection,
        vault,
        message_id,
        PlannedLocalEffect::SoftDelete,
        ImapMessageFlag::Deleted,
        true,
    )
}

fn plan_remote_message_action<V>(
    connection: &Connection,
    vault: &V,
    message_id: &str,
    effect: PlannedLocalEffect,
    remote_flag: ImapMessageFlag,
    remote_enabled: bool,
) -> Result<RemoteFlagPlan, AppError>
where
    V: SecretVaultAdapter,
{
    let Some(context) =
        get_imap_message_action_context(connection, message_id).map_err(storage_error)?
    else {
        return Ok(RemoteFlagPlan {
            message_id: message_id.to_string(),
            effect,
            remote: None,
        });
    };

    let (profile, secret) = imap_profile_and_secret(vault, &context)?;
    Ok(RemoteFlagPlan {
        message_id: message_id.to_string(),
        effect,
        remote: Some(PlannedRemotePush {
            remote_flag,
            remote_enabled,
            profile,
            secret,
            folder: context_folder_to_imap(&context),
            provider_message_id: context.provider_message_id,
        }),
    })
}

/// Phase 2: the IMAP round trip. Takes no `&Connection`, so it cannot hold the
/// database lock.
pub fn push_planned_remote_flag<A>(adapter: &A, plan: &RemoteFlagPlan) -> Result<(), AppError>
where
    A: ImapAdapter,
{
    let Some(remote) = plan.remote.as_ref() else {
        return Ok(());
    };

    adapter.set_message_flag(
        &remote.profile,
        &remote.secret,
        &remote.folder,
        &remote.provider_message_id,
        remote.remote_flag,
        remote.remote_enabled,
    )
}

/// Phase 3: perform the local write and report what happened.
pub fn persist_planned_remote_flag(
    connection: &Connection,
    plan: RemoteFlagPlan,
    now: &str,
) -> Result<NormalMessageActionResult, AppError> {
    let RemoteFlagPlan {
        message_id,
        effect,
        remote,
    } = plan;
    let remote_applied = remote.is_some();

    let (changed, status) = match effect {
        PlannedLocalEffect::SetFlag {
            local_flag_name,
            enabled,
        } => {
            let changed =
                set_message_source_flag(connection, &message_id, local_flag_name, enabled, now)
                    .map_err(storage_error)?;
            let status = match (remote_applied, enabled) {
                (true, true) => format!("remote_{local_flag_name}"),
                (true, false) => format!("remote_{local_flag_name}_cleared"),
                (false, true) => local_flag_name.to_string(),
                (false, false) => format!("{local_flag_name}_cleared"),
            };
            (changed, status)
        }
        PlannedLocalEffect::SoftDelete => {
            let changed =
                soft_delete_message(connection, &message_id, now).map_err(storage_error)?;
            let status = if remote_applied {
                "remote_deleted_forever".to_string()
            } else {
                "deleted_forever".to_string()
            };
            (changed, status)
        }
    };

    if remote_applied {
        Ok(remote_action_result(&message_id, changed, status))
    } else {
        Ok(local_action_result(&message_id, changed, status))
    }
}

/// Applies a flag action end to end.
///
/// Prefer the phased trio ([`plan_remote_flag_action`], [`push_planned_remote_flag`],
/// [`persist_planned_remote_flag`]) from command handlers: this entry point performs
/// an IMAP round trip, and the caller's database lock would be held for its whole
/// duration.
pub(super) fn apply_remote_flag_action<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    message_id: &str,
    kind: RemoteFlagKind,
    enabled: bool,
    now: &str,
) -> Result<NormalMessageActionResult, AppError>
where
    V: SecretVaultAdapter,
    A: ImapAdapter,
{
    let plan = plan_remote_flag_action(connection, vault, message_id, kind, enabled)?;
    push_planned_remote_flag(adapter, &plan)?;
    persist_planned_remote_flag(connection, plan, now)
}
