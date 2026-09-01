use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::imap::adapter::ImapAdapter;
use crate::imap::models::{
    ImapConnectionProfile, ImapFolder, ImapMessageBody, ImapMessageFlag, ImapMessageMoveResult,
};
use crate::secret::SecretVaultAdapter;
use crate::smtp::adapter::SmtpAdapter;
use crate::smtp::models::SmtpConnectionProfile;
use crate::storage::account_repository::{
    get_normal_imap_source_for_account, insert_normal_imap_account, insert_smtp_source_for_account,
    mark_account_send_enabled, mark_account_send_status, mark_imap_source_sync_success,
    update_mailbox_source_credential_ref, AccountRow, NewNormalImapAccount,
    NewSmtpSourceForAccount,
};
use crate::storage::credential_repository::{
    insert_credential_ref, CredentialRefRow, NewCredentialRef,
};
use crate::storage::mail_folder_repository::{
    list_mail_folders_for_source, upsert_mail_folder, MailFolderRow,
};
use crate::storage::message_repository::{
    get_imap_body_fetch_context, get_imap_message_action_context, get_message_detail,
    persist_imap_headers, set_message_source_flag, set_message_source_folder,
    set_message_source_remote_folder, soft_delete_message, update_message_body_cache,
    ImapBodyFetchContextRow, ImapMessageActionContextRow, NormalMessageDetailRow,
    PersistObservedMessagesResult,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualImapAccountRequest {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddManualImapAccountResult {
    pub account: AccountRow,
    pub credential: CredentialRefRow,
}

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

pub fn add_manual_imap_account<V, I, S>(
    connection: &Connection,
    vault: &V,
    imap_adapter: &I,
    smtp_adapter: &S,
    request: ManualImapAccountRequest,
    now: String,
) -> Result<AddManualImapAccountResult, AppError>
where
    V: SecretVaultAdapter,
    I: ImapAdapter,
    S: SmtpAdapter,
{
    let request = normalize_manual_imap_account_request(request)?;
    let imap_profile = imap_profile_from_request(&request);
    let smtp_profile = smtp_profile_from_request(&request);
    imap_adapter.test_connection(&imap_profile, &request.imap_password)?;
    let smtp_test_result = smtp_adapter.test_connection(&smtp_profile, &request.smtp_password);

    let (account, source_id) = insert_normal_imap_account(
        connection,
        NewNormalImapAccount {
            display_name: request.display_name.clone(),
            email_address: request.email_address.clone(),
            imap_host: request.imap_host.clone(),
            imap_port: request.imap_port,
            imap_security: request.imap_security.clone(),
            imap_username: request.imap_username.clone(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;

    let secret_key = format!("secret://imap/{}", account.id);
    let credential = insert_credential_ref(
        connection,
        NewCredentialRef {
            owner_account_id: account.id.clone(),
            source_id: source_id.clone(),
            secret_backend: "secret_vault".to_string(),
            secret_key: secret_key.clone(),
            credential_kind: "imap_password".to_string(),
            auth_method: "password".to_string(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    vault.save_secret(&secret_key, &request.imap_password)?;
    update_mailbox_source_credential_ref(connection, &source_id, &credential.id, &now)
        .map_err(storage_error)?;

    let smtp_source_id = insert_smtp_source_for_account(
        connection,
        NewSmtpSourceForAccount {
            account_id: account.id.clone(),
            email_address: request.email_address,
            smtp_host: request.smtp_host,
            smtp_port: request.smtp_port,
            smtp_security: request.smtp_security,
            smtp_username: request.smtp_username,
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let smtp_secret_key = format!("secret://smtp/{}", account.id);
    let smtp_credential = insert_credential_ref(
        connection,
        NewCredentialRef {
            owner_account_id: account.id.clone(),
            source_id: smtp_source_id.clone(),
            secret_backend: "secret_vault".to_string(),
            secret_key: smtp_secret_key.clone(),
            credential_kind: "smtp_password".to_string(),
            auth_method: "password".to_string(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    vault.save_secret(&smtp_secret_key, &request.smtp_password)?;
    update_mailbox_source_credential_ref(connection, &smtp_source_id, &smtp_credential.id, &now)
        .map_err(storage_error)?;
    if let Err(error) = smtp_test_result {
        mark_account_send_status(
            connection,
            &account.id,
            smtp_send_status_for_error(&error),
            &now,
        )
        .map_err(storage_error)?;
    } else {
        mark_account_send_enabled(connection, &account.id, &now).map_err(storage_error)?;
    }
    let account = crate::storage::account_repository::get_account(connection, &account.id)
        .map_err(storage_error)?
        .ok_or_else(|| {
            AppError::internal(
                "normal_account_missing_after_update",
                "Account missing after SMTP setup.",
            )
        })?;

    Ok(AddManualImapAccountResult {
        account,
        credential,
    })
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

/// What the cached read phase produced, plus the IMAP fetch still outstanding.
///
/// Deliberately not `Debug`: `secret` holds a decrypted mailbox credential.
pub enum MessageDetailPlan {
    /// Either the message is missing or the cached body is already good enough,
    /// so no network work is required.
    Complete(Box<Option<NormalMessageDetailRow>>),
    /// The body must be fetched over IMAP before the detail is complete.
    NeedsBody(Box<MessageDetailFetchPlan>),
}

/// Data required by the lock-free IMAP phase. Boxed in [`MessageDetailPlan`]
/// so cached results do not carry the size of the network-fetch variant.
pub struct MessageDetailFetchPlan {
    detail: NormalMessageDetailRow,
    message_id: String,
    profile: ImapConnectionProfile,
    secret: String,
    folder: ImapFolder,
    provider_message_id: String,
}

impl MessageDetailPlan {
    /// Whether this plan still needs the lock-free IMAP fetch phase. Lets a
    /// caller skip releasing its lock when the cache already answered.
    pub fn needs_fetch(&self) -> bool {
        matches!(self, MessageDetailPlan::NeedsBody(_))
    }
}

/// Loads a message detail, fetching the body over IMAP when the cache misses.
///
/// Prefer the phased trio ([`plan_message_detail`], [`fetch_planned_message_body`],
/// [`persist_planned_message_body`]) from command handlers: a cache miss here
/// performs a full IMAP connect, and the caller's database lock would be held for
/// the entire round trip. This entry point remains for callers that already own an
/// exclusive connection.
pub fn load_message_detail_with_imap_body<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    message_id: &str,
    now: String,
) -> Result<Option<NormalMessageDetailRow>, AppError>
where
    V: SecretVaultAdapter,
    A: ImapAdapter,
{
    let plan = plan_message_detail(connection, vault, message_id)?;
    let fetched = fetch_planned_message_body(adapter, &plan)?;
    persist_planned_message_body(connection, plan, fetched, &now)
}

/// Phase 1: the cached read and credential load. Touches the database and the
/// secret vault, never the network, so the caller can drop its lock afterward.
pub fn plan_message_detail<V>(
    connection: &Connection,
    vault: &V,
    message_id: &str,
) -> Result<MessageDetailPlan, AppError>
where
    V: SecretVaultAdapter,
{
    let Some(detail) = get_message_detail(connection, message_id).map_err(storage_error)? else {
        return Ok(MessageDetailPlan::Complete(Box::new(None)));
    };

    if detail.body_cache_state == "cached"
        && detail
            .body_text
            .as_deref()
            .is_some_and(|body| !cached_body_needs_refetch(body))
    {
        return Ok(MessageDetailPlan::Complete(Box::new(Some(detail))));
    }

    let Some(fetch_context) =
        get_imap_body_fetch_context(connection, message_id).map_err(storage_error)?
    else {
        return Ok(MessageDetailPlan::Complete(Box::new(Some(detail))));
    };
    let secret = vault
        .load_secret(&fetch_context.secret_key)?
        .ok_or_else(|| imap_secret_missing(&fetch_context.account_id))?;

    Ok(MessageDetailPlan::NeedsBody(Box::new(
        MessageDetailFetchPlan {
            message_id: message_id.to_string(),
            profile: ImapConnectionProfile {
                host: fetch_context.config.host.clone(),
                port: fetch_context.config.port,
                security: fetch_context.config.security.clone(),
                username: fetch_context.config.username.clone(),
            },
            secret,
            folder: body_fetch_context_folder_to_imap(&fetch_context),
            provider_message_id: fetch_context.provider_message_id.clone(),
            detail,
        },
    )))
}

/// Phase 2: the IMAP round trip. Takes no connection so it cannot hold the lock.
pub fn fetch_planned_message_body<A>(
    adapter: &A,
    plan: &MessageDetailPlan,
) -> Result<Option<ImapMessageBody>, AppError>
where
    A: ImapAdapter,
{
    match plan {
        MessageDetailPlan::Complete(_) => Ok(None),
        MessageDetailPlan::NeedsBody(fetch) => adapter.fetch_message_body(
            &fetch.profile,
            &fetch.secret,
            &fetch.folder,
            &fetch.provider_message_id,
        ),
    }
}

/// Phase 3: cache the fetched body and re-read the completed detail.
pub fn persist_planned_message_body(
    connection: &Connection,
    plan: MessageDetailPlan,
    body: Option<ImapMessageBody>,
    now: &str,
) -> Result<Option<NormalMessageDetailRow>, AppError> {
    let (detail, message_id) = match plan {
        MessageDetailPlan::Complete(detail) => return Ok(*detail),
        MessageDetailPlan::NeedsBody(fetch) => {
            let MessageDetailFetchPlan {
                detail, message_id, ..
            } = *fetch;
            (detail, message_id)
        }
    };

    // A mailbox that no longer holds the message leaves the cached detail as the
    // best available answer.
    let Some(body) = body else {
        return Ok(Some(detail));
    };

    update_message_body_cache(
        connection,
        &message_id,
        &body.text,
        body.html.as_deref(),
        now,
    )
    .map_err(storage_error)?;
    get_message_detail(connection, &message_id).map_err(storage_error)
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
fn apply_remote_flag_action<V, A>(
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

fn apply_archive_action<V, A>(
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
fn apply_planned_move_effect(
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
fn apply_move_action<V, A>(
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

fn apply_delete_action<V, A>(
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
fn apply_permanent_delete_action<V, A>(
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

fn imap_profile_and_secret<V: SecretVaultAdapter>(
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

fn resolve_target_folder<A: ImapAdapter>(
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

fn find_folder_for_kind(folders: &[MailFolderRow], target_kind: &str) -> Option<MailFolderRow> {
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

fn folder_matches_kind(folder: &MailFolderRow, target_kind: &str) -> bool {
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

fn normalized_folder_token(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '_' | '-'))
        .collect()
}

fn context_folder_to_imap(context: &ImapMessageActionContextRow) -> ImapFolder {
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

fn body_fetch_context_folder_to_imap(context: &ImapBodyFetchContextRow) -> ImapFolder {
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

fn local_action_result(
    message_id: &str,
    changed: bool,
    status: impl Into<String>,
) -> NormalMessageActionResult {
    action_result(message_id, changed, false, status)
}

fn remote_action_result(
    message_id: &str,
    changed: bool,
    status: impl Into<String>,
) -> NormalMessageActionResult {
    action_result(message_id, changed, true, status)
}

fn action_result(
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

fn normalize_manual_imap_account_request(
    request: ManualImapAccountRequest,
) -> Result<ManualImapAccountRequest, AppError> {
    let normalized = ManualImapAccountRequest {
        display_name: request.display_name.trim().to_string(),
        email_address: request.email_address.trim().to_ascii_lowercase(),
        imap_host: request.imap_host.trim().to_ascii_lowercase(),
        imap_port: request.imap_port,
        imap_security: request.imap_security.trim().to_ascii_lowercase(),
        imap_username: request.imap_username.trim().to_string(),
        imap_password: request.imap_password,
        smtp_host: request.smtp_host.trim().to_ascii_lowercase(),
        smtp_port: request.smtp_port,
        smtp_security: request.smtp_security.trim().to_ascii_lowercase(),
        smtp_username: request.smtp_username.trim().to_string(),
        smtp_password: request.smtp_password,
    };

    if normalized.display_name.is_empty()
        || normalized.email_address.is_empty()
        || normalized.imap_host.is_empty()
        || normalized.imap_username.is_empty()
        || normalized.imap_password.is_empty()
        || normalized.smtp_host.is_empty()
        || normalized.smtp_username.is_empty()
        || normalized.smtp_password.is_empty()
    {
        return Err(AppError {
            code: "manual_imap_account_invalid".to_string(),
            category: ErrorCategory::Validation,
            user_message:
                "Enter mailbox identity, IMAP settings, SMTP settings, usernames, and app passwords."
                    .to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::EditSettings,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }

    if !matches!(
        normalized.imap_security.as_str(),
        "tls" | "ssl" | "starttls"
    ) || !matches!(normalized.smtp_security.as_str(), "tls" | "starttls")
    {
        return Err(AppError {
            code: "manual_mail_security_invalid".to_string(),
            category: ErrorCategory::Validation,
            user_message: "IMAP and SMTP must use TLS or STARTTLS.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::EditSettings,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }

    Ok(normalized)
}

fn cached_body_needs_refetch(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    body.contains('\u{fffd}')
        || lower.contains("content-transfer-encoding:")
        || lower.contains("content-type:")
        || lower.contains("=e4=")
        || lower.contains("=e5=")
        || lower.contains("=e6=")
        || lower.contains("=c2=")
        || lower.contains("=c3=")
        || lower.contains("=\r\n")
        || lower.contains("=\n")
        || lower.contains("<html")
        || lower.contains("<body")
        || lower.contains("<p")
        || lower.contains("</p>")
        || lower.contains("<div")
        || lower.contains("</div>")
        || lower.contains("<br")
        || lower.contains("<span")
        || lower.contains("</span>")
        || lower.contains("<table")
        || lower.contains("](")
        || lower.contains("to view this email as a web page")
        || lower.contains("view this email as a web page")
}

fn imap_profile_from_request(request: &ManualImapAccountRequest) -> ImapConnectionProfile {
    ImapConnectionProfile {
        host: request.imap_host.clone(),
        port: request.imap_port,
        security: request.imap_security.clone(),
        username: request.imap_username.clone(),
    }
}

fn smtp_profile_from_request(request: &ManualImapAccountRequest) -> SmtpConnectionProfile {
    SmtpConnectionProfile {
        host: request.smtp_host.clone(),
        port: request.smtp_port,
        security: request.smtp_security.clone(),
        username: request.smtp_username.clone(),
    }
}

fn smtp_send_status_for_error(error: &AppError) -> &'static str {
    match error.category {
        ErrorCategory::Auth => "auth_failed",
        _ => "smtp_unavailable",
    }
}

fn ensure_sync_folder<A: ImapAdapter>(
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

fn choose_inbox_folder(folders: Vec<MailFolderRow>) -> Option<MailFolderRow> {
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

fn folder_to_imap(folder: &MailFolderRow) -> ImapFolder {
    ImapFolder {
        provider_folder_id: folder.provider_folder_id.clone(),
        display_name: folder.display_name.clone(),
        path: folder.path.clone(),
        delimiter: folder.delimiter.clone().unwrap_or_else(|| "/".to_string()),
        folder_kind: folder.folder_kind.clone(),
    }
}

fn normal_imap_account_not_found(account_id: &str) -> AppError {
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

fn normal_message_action_invalid() -> AppError {
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

fn imap_secret_missing(account_id: &str) -> AppError {
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

fn imap_inbox_missing(account_id: &str) -> AppError {
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

fn storage_error(error: rusqlite::Error) -> AppError {
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

#[cfg(test)]
fn assert_no_sqlite_value_contains(connection: &Connection, needle: &str) {
    use rusqlite::types::ValueRef;

    let table_names = {
        let mut statement = connection
            .prepare(
                "SELECT name
                 FROM sqlite_master
                 WHERE type = 'table'
                   AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .expect("prepare table list");
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query table list")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect table list")
    };

    for table_name in table_names {
        let sql = format!("SELECT * FROM {table_name}");
        let mut statement = connection.prepare(&sql).expect("prepare table scan");
        let column_count = statement.column_count();
        let mut rows = statement.query([]).expect("query table scan");
        while let Some(row) = rows.next().expect("next table row") {
            for index in 0..column_count {
                if let ValueRef::Text(value) = row.get_ref(index).expect("read sqlite value") {
                    let value = std::str::from_utf8(value).expect("sqlite text is utf8");
                    assert!(
                        !value.contains(needle),
                        "SQLite table {table_name} column {index} leaked secret value"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
fn assert_no_normal_account_created(connection: &Connection) {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*)
             FROM accounts
             WHERE scope = 'normal'
               AND kind = 'normal_long_lived'",
            [],
            |row| row.get(0),
        )
        .expect("count normal accounts");

    assert_eq!(count, 0);
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::imap::fake::{FakeImapAction, FakeImapAdapter};
    use crate::imap::models::{ImapFolder, ImapMessageBody, ImapMessageHeader};
    use crate::secret::fake::FakeSecretVaultAdapter;
    use crate::secret::SecretVaultAdapter;
    use crate::smtp::fake::FakeSmtpAdapter;
    use crate::storage::account_repository::get_smtp_source_for_account;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::message_repository::{
        list_normal_account_messages, list_normal_account_messages_with_options,
        update_message_body_text_cache,
    };
    use crate::storage::migrations::run_migrations;
    use crate::storage::verification_repository::{
        list_recent_verification_codes, RecentVerificationCodeFilter,
    };

    use super::*;

    #[test]
    fn manual_account_create_saves_credential_ref_not_secret() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let imap_adapter = FakeImapAdapter::with_connection_success();
        let smtp_adapter = FakeSmtpAdapter::success();

        let result = add_manual_imap_account(
            &connection,
            &vault,
            &imap_adapter,
            &smtp_adapter,
            manual_request(),
            "2026-06-12T00:00:00Z".to_string(),
        )
        .expect("add manual imap");

        assert_eq!(result.account.kind, "normal_long_lived");
        assert_eq!(result.account.send_status, "enabled");
        assert!(vault
            .exists(&result.credential.secret_key)
            .expect("secret exists"));
        let smtp_source = get_smtp_source_for_account(&connection, &result.account.id)
            .expect("query smtp source")
            .expect("smtp source exists");
        assert_eq!(smtp_source.config.host, "smtp.example.test");
        assert_eq!(smtp_source.config.port, 465);
        assert!(vault
            .exists(&smtp_source.secret_key)
            .expect("smtp secret exists"));
        assert_no_sqlite_value_contains(&connection, "app-password");
    }

    #[test]
    fn manual_account_rejects_plaintext_mail_security() {
        let error = normalize_manual_imap_account_request(ManualImapAccountRequest {
            imap_security: "plain".to_string(),
            smtp_security: "none".to_string(),
            ..manual_request()
        })
        .expect_err("plaintext security rejected");

        assert_eq!(error.code, "manual_mail_security_invalid");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn normal_account_initial_sync_saves_messages() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);

        let sync = sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");

        assert_eq!(sync.inserted_count, 1);
        assert_eq!(
            list_normal_account_messages(&connection, &result.account.id)
                .expect("messages")
                .len(),
            1
        );
    }

    #[test]
    fn normal_account_sync_extracts_codes_for_inserted_messages() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![ImapMessageHeader {
            provider_message_id: "uid-otp-1".to_string(),
            message_id: Some("otp-1@example.test".to_string()),
            in_reply_to: None,
            references: Vec::new(),
            subject: "OpenAI sign in".to_string(),
            from_address: "noreply@openai.com".to_string(),
            date_received: "2026-06-12T00:05:00Z".to_string(),
            snippet: "Your verification code is 996703".to_string(),
            authentication_results: None,
            received_spf: None,
            dkim_signature: None,
            list_id: None,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            precedence: None,
            list_post: None,
            list_help: None,
            feedback_id: None,
        }]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);

        let sync = sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");

        assert_eq!(sync.inserted_count, 1);

        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");
        let rows = list_recent_verification_codes(
            &connection,
            RecentVerificationCodeFilter {
                temp_mailbox_id: None,
                limit: 10,
            },
        )
        .expect("list codes");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id, message.message_id);
        assert_eq!(rows[0].code, "996703");
    }

    #[test]
    fn normal_account_sync_imports_remote_spam_folder_messages_as_spam() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_connection_success()
            .with_folders(test_remote_folders())
            .with_recent_headers_by_folder(vec![
                ("INBOX", vec![fake_header("uid-inbox", "Welcome")]),
                ("Spam", vec![fake_header("uid-spam", "Suspicious offer")]),
            ]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);

        let sync = sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");

        let messages =
            list_normal_account_messages(&connection, &result.account.id).expect("messages");
        assert_eq!(sync.inserted_count, 2);
        assert_eq!(messages.len(), 2);
        assert!(messages.iter().any(|message| {
            message.subject == "Welcome" && message.local_state.local_folder == "inbox"
        }));
        assert!(messages.iter().any(|message| {
            message.subject == "Suspicious offer" && message.local_state.local_folder == "spam"
        }));
    }

    #[test]
    fn normal_account_sync_discovers_spam_folder_after_inbox_was_already_stored() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let initial_adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-inbox", "Welcome")]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &initial_adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &initial_adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("initial sync");

        let later_adapter = FakeImapAdapter::with_connection_success()
            .with_folders(test_remote_folders())
            .with_recent_headers_by_folder(vec![
                ("INBOX", vec![fake_header("uid-inbox", "Welcome")]),
                ("Spam", vec![fake_header("uid-spam", "Suspicious offer")]),
            ]);
        let sync = sync_recent_headers(
            &connection,
            &vault,
            &later_adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("later sync");

        let messages =
            list_normal_account_messages(&connection, &result.account.id).expect("messages");
        assert_eq!(sync.inserted_count, 1);
        assert!(messages.iter().any(|message| {
            message.subject == "Suspicious offer" && message.local_state.local_folder == "spam"
        }));
    }

    #[test]
    fn normal_account_detail_fetches_and_caches_body_when_headers_only() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let detail = load_message_detail_with_imap_body(
            &connection,
            &vault,
            &adapter,
            &message.message_id,
            "2026-06-12T00:15:00Z".to_string(),
        )
        .expect("detail")
        .expect("detail exists");

        assert_eq!(detail.body_text, Some("Body for uid-1".to_string()));
        assert_eq!(detail.body_cache_state, "cached");
    }

    #[test]
    fn normal_account_detail_caches_rich_html_body() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "OpenAI code")])
                .with_message_body(ImapMessageBody {
                    text: "Your OpenAI code is 996703".to_string(),
                    html: Some(
                        r#"<!doctype html><html><body><h1>OpenAI</h1><div style="background:#f3f3f3">996703</div></body></html>"#
                            .to_string(),
                    ),
                });
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let detail = load_message_detail_with_imap_body(
            &connection,
            &vault,
            &adapter,
            &message.message_id,
            "2026-06-12T00:15:00Z".to_string(),
        )
        .expect("detail")
        .expect("detail exists");

        assert_eq!(
            detail.body_text,
            Some("Your OpenAI code is 996703".to_string())
        );
        assert!(detail
            .body_html
            .as_deref()
            .is_some_and(|html| html.contains("<h1>OpenAI</h1>")));
        assert_eq!(detail.body_cache_state, "cached");
    }

    #[test]
    fn cached_message_detail_plan_requires_no_imap_fetch() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")])
            .with_message_body(ImapMessageBody {
                text: "Body for uid-1".to_string(),
                html: None,
            });
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = load_message_detail_with_imap_body(
            &connection,
            &vault,
            &adapter,
            &list_normal_account_messages(&connection, &result.account.id)
                .expect("messages")
                .pop()
                .expect("message")
                .message_id,
            "2026-06-12T00:15:00Z".to_string(),
        )
        .expect("prime the body cache")
        .expect("detail exists");
        assert_eq!(message.body_cache_state, "cached");

        // The body is cached now, so planning must resolve the detail outright and
        // leave nothing for the lock-free fetch phase to do.
        let plan = plan_message_detail(&connection, &vault, &message.message_id)
            .expect("plan cached detail");
        assert!(!plan.needs_fetch());

        let before = adapter.recorded_actions().len();
        let body = fetch_planned_message_body(&adapter, &plan).expect("fetch phase");

        assert!(body.is_none());
        assert_eq!(
            adapter.recorded_actions().len(),
            before,
            "a cached body must not reach IMAP"
        );

        let detail = persist_planned_message_body(&connection, plan, body, "2026-06-12T00:20:00Z")
            .expect("persist phase")
            .expect("detail exists");
        assert_eq!(detail.body_text, Some("Body for uid-1".to_string()));
    }

    #[test]
    fn normal_message_read_action_updates_imap_seen_and_local_cache() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")])
            .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let action = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::SetRead(true),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply read action");
        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");

        assert!(action.changed);
        assert!(action.remote_applied);
        assert_eq!(
            adapter.recorded_actions(),
            vec![FakeImapAction::SetFlag {
                folder_path: "INBOX".to_string(),
                provider_message_id: "uid-1".to_string(),
                flag: "\\Seen".to_string(),
                enabled: true,
            }]
        );
        assert!(messages_after[0].local_state.is_read);
    }

    #[test]
    fn normal_message_star_action_updates_imap_flagged_and_local_cache() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-star", "Star me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let action = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::SetStarred(true),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply star action");
        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");

        assert!(action.changed);
        assert!(action.remote_applied);
        assert_eq!(
            adapter.recorded_actions(),
            vec![FakeImapAction::SetFlag {
                folder_path: "INBOX".to_string(),
                provider_message_id: "uid-star".to_string(),
                flag: "\\Flagged".to_string(),
                enabled: true,
            }]
        );
        assert!(messages_after[0].local_state.is_starred);
    }

    /// Note on what this does and does not prove: that planning performs no IMAP
    /// call is guaranteed by `plan_remote_flag_action` taking no adapter, not by
    /// any assertion here. What is actually worth testing is that the plan carries
    /// the correct folder and provider id across the lock release, since planning
    /// is the last phase with database access.
    #[test]
    fn planned_flag_action_targets_the_same_folder_and_uid_after_the_lock_release() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")])
            .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let plan = plan_remote_flag_action(
            &connection,
            &vault,
            &message.message_id,
            RemoteFlagKind::Read,
            true,
        )
        .expect("plan phase");

        let after_plan = adapter.recorded_actions().len();
        assert!(plan.needs_remote());

        push_planned_remote_flag(&adapter, &plan).expect("push phase");

        // The plan must have captured the real folder and provider id while it had
        // database access; getting either wrong would target the wrong message.
        assert_eq!(
            adapter.recorded_actions()[after_plan..],
            [FakeImapAction::SetFlag {
                folder_path: "INBOX".to_string(),
                provider_message_id: "uid-1".to_string(),
                flag: "\\Seen".to_string(),
                enabled: true,
            }]
        );

        let action = persist_planned_remote_flag(&connection, plan, "2026-06-12T00:20:00Z")
            .expect("persist phase");
        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");

        assert!(action.changed);
        assert!(action.remote_applied);
        assert_eq!(action.status, "remote_read");
        assert!(messages_after[0].local_state.is_read);
    }

    #[test]
    fn planned_permanent_delete_sets_remote_deleted_flag_then_soft_deletes_locally() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-gone", "Bye")])
            .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let plan = plan_permanent_delete_action(&connection, &vault, &message.message_id)
            .expect("plan phase");
        let after_plan = adapter.recorded_actions().len();
        assert!(plan.needs_remote());

        push_planned_remote_flag(&adapter, &plan).expect("push phase");

        assert_eq!(
            adapter.recorded_actions()[after_plan..],
            [FakeImapAction::SetFlag {
                folder_path: "INBOX".to_string(),
                provider_message_id: "uid-gone".to_string(),
                flag: "\\Deleted".to_string(),
                enabled: true,
            }]
        );

        let action = persist_planned_remote_flag(&connection, plan, "2026-06-12T00:20:00Z")
            .expect("persist phase");

        assert!(action.changed);
        assert!(action.remote_applied);
        assert_eq!(action.status, "remote_deleted_forever");
        assert!(
            list_normal_account_messages(&connection, &result.account.id)
                .expect("messages after")
                .is_empty(),
            "a permanently deleted message must not stay in the account listing"
        );
    }

    #[test]
    fn phased_flag_action_on_a_message_without_imap_source_stays_local() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(Vec::new());

        let plan = plan_remote_flag_action(
            &connection,
            &vault,
            "missing-message",
            RemoteFlagKind::Starred,
            true,
        )
        .expect("plan phase");

        // Without an IMAP source the caller can keep its lock: there is no round
        // trip to make room for.
        assert!(!plan.needs_remote());

        let action = persist_planned_remote_flag(&connection, plan, "2026-06-12T00:20:00Z")
            .expect("persist phase");

        assert!(!action.remote_applied);
        assert_eq!(action.status, "starred");
        assert!(adapter.recorded_actions().is_empty());
    }

    #[test]
    fn normal_message_move_action_moves_remote_to_spam_and_updates_local_folder() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let action = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::MoveTo("spam".to_string()),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply move action");
        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");

        assert!(action.changed);
        assert!(action.remote_applied);
        assert_eq!(
            adapter.recorded_actions(),
            vec![FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Spam".to_string(),
                provider_message_id: "uid-spam".to_string(),
            }]
        );
        assert_eq!(messages_after[0].local_state.local_folder, "spam");
    }

    /// Pins which branch of `resolve_target_folder` a synced account actually
    /// takes, because a proposed refactor turns that function into a pure read.
    ///
    /// `with_folders` supplies what discovery *returns*; it does not populate the
    /// local folder cache. The cache is populated by `sync_recent_headers`, which
    /// upserts discovered folders. So for a synced account the action resolves
    /// from the cache and never reaches the network — which is what makes the
    /// pure-read refactor safe on this path. The untested risk is the account that
    /// has never synced folders at all.
    #[test]
    fn move_action_on_a_synced_account_resolves_the_target_folder_without_discovery() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        // Sync itself discovers folders, so the baseline is taken after setup to
        // attribute any further discovery to the action under test.
        let discoveries_before = adapter.discover_folders_call_count();

        apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::MoveTo("spam".to_string()),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply move action");

        assert_eq!(
            adapter.discover_folders_call_count(),
            discoveries_before,
            "a synced account must resolve the target folder from the local cache; \
             sync already upserted the folders, so the action itself needs no \
             network discovery"
        );
    }

    /// Pins what happens when the target folder cannot be resolved at all: the
    /// local state still changes and `remote_applied` reports false, with no
    /// error. Both `resolve_target_folder` call sites share this shape.
    ///
    /// This is the safety net for turning `resolve_target_folder` into a pure
    /// read. That change would make an uncached target resolve to `None`, and
    /// this test records that `None` degrades to local-only rather than failing —
    /// which also means the failure mode is *silent* divergence from the server,
    /// so a pure read is only safe if sync reliably caches every target folder.
    #[test]
    fn move_action_degrades_to_local_only_when_the_target_folder_does_not_exist_remotely() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        // A server that only has INBOX: nothing can resolve to a spam folder,
        // neither from the cache nor from discovery.
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-only-inbox", "Move me")])
                .with_folders(vec![test_folder("INBOX", "INBOX", "inbox")]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let action = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::MoveTo("spam".to_string()),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("an unresolvable target folder must not be an error");

        assert!(
            !action.remote_applied,
            "no remote move is possible when the target folder does not exist"
        );
        assert!(
            !adapter
                .recorded_actions()
                .iter()
                .any(|entry| matches!(entry, FakeImapAction::Move { .. })),
            "no Move may be sent for a folder that could not be resolved"
        );

        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");
        assert_eq!(
            messages_after[0].local_state.local_folder, "spam",
            "the local folder still changes, so local and server state diverge"
        );
    }

    /// The phased move must reach the same end state as the locked path, and must
    /// send its IMAP move only from the phase that holds no database lock.
    #[test]
    fn planned_move_matches_the_locked_path_and_sends_its_move_after_planning() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let plan =
            plan_move_action(&connection, &vault, &message.message_id, "spam").expect("plan phase");

        // A synced account must resolve the target from cache, so the lock-free
        // path applies rather than the locked fallback.
        assert!(
            !plan.requires_locked_fallback(),
            "a synced account must not need the locked fallback"
        );
        assert!(plan.needs_remote());

        let before_fetch = adapter.recorded_actions().len();
        let move_result = fetch_planned_move(&adapter, &plan).expect("fetch phase");

        // The plan must have captured the right source folder and uid while it
        // still had database access.
        assert_eq!(
            adapter.recorded_actions()[before_fetch..],
            [FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Spam".to_string(),
                provider_message_id: "uid-spam".to_string(),
            }]
        );

        let action = persist_planned_move(&connection, plan, move_result, "2026-06-12T00:20:00Z")
            .expect("persist phase");
        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");

        assert!(action.changed);
        assert!(action.remote_applied);
        assert_eq!(action.status, "remote_folder:spam");
        assert_eq!(messages_after[0].local_state.local_folder, "spam");
    }

    /// A target folder missing from the cache must report the locked fallback
    /// rather than silently skipping the remote move. This is what keeps the
    /// phased path from degrading behaviour: resolving an uncached folder needs a
    /// network discovery interleaved with the writes that assign folder ids.
    #[test]
    fn planned_move_requires_the_locked_fallback_when_the_target_is_not_cached() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        // Sync caches only INBOX, so "spam" cannot resolve from the cache.
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-nocache", "Move me")])
                .with_folders(vec![test_folder("INBOX", "INBOX", "inbox")]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let plan =
            plan_move_action(&connection, &vault, &message.message_id, "spam").expect("plan phase");

        assert!(
            plan.requires_locked_fallback(),
            "an uncached target must defer to the locked path, not skip the move"
        );
        assert!(!plan.needs_remote());
    }

    /// A folder with no remote counterpart stays local, and the phased path must
    /// not attempt any IMAP call for it.
    #[test]
    fn planned_move_to_a_local_only_folder_sends_nothing() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(Vec::new());

        let plan =
            plan_move_action(&connection, &vault, "missing-message", "later").expect("plan phase");

        assert!(!plan.needs_remote());
        assert!(!plan.requires_locked_fallback());

        let move_result = fetch_planned_move(&adapter, &plan).expect("fetch phase");
        assert!(move_result.is_none());
        assert!(adapter.recorded_actions().is_empty());
    }

    /// The phased archive must reach the same end state as the locked path, and
    /// send its IMAP move only from the phase holding no database lock.
    #[test]
    fn planned_archive_moves_to_the_archive_folder_and_sets_the_local_flag() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-arch", "Archive me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let plan = plan_archive_action(&connection, &vault, &message.message_id, true)
            .expect("plan phase");

        assert!(
            !plan.requires_locked_fallback(),
            "a synced account must resolve the archive folder from cache"
        );
        assert!(plan.needs_remote());

        let before_fetch = adapter.recorded_actions().len();
        let move_result = fetch_planned_move(&adapter, &plan).expect("fetch phase");

        assert_eq!(
            adapter.recorded_actions()[before_fetch..],
            [FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Archive".to_string(),
                provider_message_id: "uid-arch".to_string(),
            }]
        );

        let action = persist_planned_move(&connection, plan, move_result, "2026-06-12T00:20:00Z")
            .expect("persist phase");

        assert!(action.changed);
        assert!(action.remote_applied);
        assert_eq!(action.status, "remote_archived");

        // Archived messages drop out of the default listing.
        assert!(
            list_normal_account_messages(&connection, &result.account.id)
                .expect("messages after")
                .is_empty(),
            "an archived message must not remain in the default listing"
        );
    }

    /// Un-archiving only clears a local flag, so it must never plan remote work.
    #[test]
    fn planned_archive_clearing_stays_local_and_sends_nothing() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(Vec::new());

        let plan =
            plan_archive_action(&connection, &vault, "some-message", false).expect("plan phase");

        assert!(!plan.needs_remote());
        assert!(!plan.requires_locked_fallback());

        let move_result = fetch_planned_move(&adapter, &plan).expect("fetch phase");
        assert!(move_result.is_none());
        assert!(adapter.recorded_actions().is_empty());

        let action = persist_planned_move(&connection, plan, None, "2026-06-12T00:20:00Z")
            .expect("persist phase");
        assert!(!action.remote_applied);
        assert_eq!(action.status, "archived_cleared");
    }

    /// An archive folder missing from the cache must defer to the locked path
    /// rather than silently skipping the remote move.
    #[test]
    fn planned_archive_requires_the_locked_fallback_when_the_archive_folder_is_not_cached() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-noarch", "Archive me")])
                .with_folders(vec![test_folder("INBOX", "INBOX", "inbox")]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let plan = plan_archive_action(&connection, &vault, &message.message_id, true)
            .expect("plan phase");

        assert!(
            plan.requires_locked_fallback(),
            "an uncached archive folder must defer to the locked path"
        );
        assert!(!plan.needs_remote());
    }

    #[test]
    fn normal_message_move_action_moves_to_custom_folder_locally() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-custom-folder", "Move me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let action = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::MoveTo("Receipts".to_string()),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply custom folder move");
        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");

        assert!(action.changed);
        assert!(!action.remote_applied);
        assert!(adapter.recorded_actions().is_empty());
        assert_eq!(messages_after[0].local_state.local_folder, "receipts");
    }

    #[test]
    fn normal_message_move_action_updates_follow_up_remote_action_folder() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::MoveTo("spam".to_string()),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply move action");
        apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::SetStarred(true),
            },
            "2026-06-12T00:21:00Z".to_string(),
        )
        .expect("apply star action after move");

        assert_eq!(
            adapter.recorded_actions(),
            vec![
                FakeImapAction::Move {
                    from_folder_path: "INBOX".to_string(),
                    target_folder_path: "Spam".to_string(),
                    provider_message_id: "uid-spam".to_string(),
                },
                FakeImapAction::SetFlag {
                    folder_path: "Spam".to_string(),
                    provider_message_id: "uid-spam".to_string(),
                    flag: "\\Flagged".to_string(),
                    enabled: true,
                },
            ]
        );
    }

    #[test]
    fn normal_message_move_action_updates_follow_up_remote_action_uid_when_server_reports_target_uid(
    ) {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
                .with_folders(test_remote_folders())
                .with_move_target_provider_message_id("uid-spam-target");
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::MoveTo("spam".to_string()),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply move action");
        apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::SetStarred(true),
            },
            "2026-06-12T00:21:00Z".to_string(),
        )
        .expect("apply star action after move");

        assert_eq!(
            adapter.recorded_actions(),
            vec![
                FakeImapAction::Move {
                    from_folder_path: "INBOX".to_string(),
                    target_folder_path: "Spam".to_string(),
                    provider_message_id: "uid-spam".to_string(),
                },
                FakeImapAction::SetFlag {
                    folder_path: "Spam".to_string(),
                    provider_message_id: "uid-spam-target".to_string(),
                    flag: "\\Flagged".to_string(),
                    enabled: true,
                },
            ]
        );
    }

    #[test]
    fn normal_account_detail_fetch_after_move_uses_current_remote_folder() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::MoveTo("spam".to_string()),
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply move action");
        load_message_detail_with_imap_body(
            &connection,
            &vault,
            &adapter,
            &message.message_id,
            "2026-06-12T00:21:00Z".to_string(),
        )
        .expect("load detail after move")
        .expect("detail exists");

        assert_eq!(
            adapter.recorded_actions(),
            vec![
                FakeImapAction::Move {
                    from_folder_path: "INBOX".to_string(),
                    target_folder_path: "Spam".to_string(),
                    provider_message_id: "uid-spam".to_string(),
                },
                FakeImapAction::FetchBody {
                    folder_path: "Spam".to_string(),
                    provider_message_id: "uid-spam".to_string(),
                },
            ]
        );
    }

    #[test]
    fn normal_message_delete_action_moves_remote_to_trash_and_keeps_local_trash_message() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-trash", "Delete me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        let action = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::Delete,
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("apply delete action");
        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");

        assert!(action.changed);
        assert!(action.remote_applied);
        assert_eq!(
            adapter.recorded_actions(),
            vec![FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Trash".to_string(),
                provider_message_id: "uid-trash".to_string(),
            }]
        );
        assert_eq!(messages_after.len(), 1);
        assert_eq!(messages_after[0].local_state.local_folder, "trash");
    }

    #[test]
    fn normal_message_restore_from_trash_moves_remote_to_inbox_and_clears_trash_folder() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-trash", "Restore me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::Delete,
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("move to trash");
        let restore = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::MoveTo("inbox".to_string()),
            },
            "2026-06-12T00:21:00Z".to_string(),
        )
        .expect("restore to inbox");
        let messages_after =
            list_normal_account_messages(&connection, &result.account.id).expect("messages after");

        assert!(restore.changed);
        assert!(restore.remote_applied);
        assert_eq!(
            adapter.recorded_actions(),
            vec![
                FakeImapAction::Move {
                    from_folder_path: "INBOX".to_string(),
                    target_folder_path: "Trash".to_string(),
                    provider_message_id: "uid-trash".to_string(),
                },
                FakeImapAction::Move {
                    from_folder_path: "Trash".to_string(),
                    target_folder_path: "INBOX".to_string(),
                    provider_message_id: "uid-trash".to_string(),
                },
            ]
        );
        assert_eq!(messages_after.len(), 1);
        assert_eq!(messages_after[0].local_state.local_folder, "inbox");
        assert!(!messages_after[0].local_state.is_archived);
    }

    #[test]
    fn normal_message_delete_forever_flags_remote_deleted_and_hides_local_trash_message() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter =
            FakeImapAdapter::with_recent_headers(vec![fake_header("uid-trash", "Empty me")])
                .with_folders(test_remote_folders());
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 25,
            },
            "2026-06-12T00:10:00Z".to_string(),
        )
        .expect("sync recent");
        let message = list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message");

        apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::Delete,
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("move to trash");
        let delete_forever = apply_normal_message_action(
            &connection,
            &vault,
            &adapter,
            NormalMessageActionRequest {
                message_id: message.message_id.clone(),
                action: NormalMessageAction::DeleteForever,
            },
            "2026-06-12T00:21:00Z".to_string(),
        )
        .expect("delete forever");
        let messages_after =
            list_normal_account_messages_with_options(&connection, &result.account.id, true)
                .expect("messages after");

        assert!(delete_forever.changed);
        assert!(delete_forever.remote_applied);
        assert_eq!(
            adapter.recorded_actions(),
            vec![
                FakeImapAction::Move {
                    from_folder_path: "INBOX".to_string(),
                    target_folder_path: "Trash".to_string(),
                    provider_message_id: "uid-trash".to_string(),
                },
                FakeImapAction::SetFlag {
                    folder_path: "Trash".to_string(),
                    provider_message_id: "uid-trash".to_string(),
                    flag: "\\Deleted".to_string(),
                    enabled: true,
                },
            ]
        );
        assert!(messages_after.is_empty());
    }

    #[test]
    fn normal_account_detail_refetches_undecoded_cached_body() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 10,
            },
            "2026-06-12T00:05:00Z".to_string(),
        )
        .expect("sync headers");
        let message_id: String = connection
            .query_row("SELECT id FROM messages LIMIT 1", [], |row| row.get(0))
            .expect("read message id");
        update_message_body_text_cache(
            &connection,
            &message_id,
            "Content-Transfer-Encoding: base64\r\n\r\nxOO6ww==",
            "2026-06-12T00:06:00Z",
        )
        .expect("seed undecoded cache");

        let detail = load_message_detail_with_imap_body(
            &connection,
            &vault,
            &adapter,
            &message_id,
            "2026-06-12T00:07:00Z".to_string(),
        )
        .expect("load detail")
        .expect("detail exists");

        assert_eq!(detail.body_text, Some("Body for uid-1".to_string()));
        assert_eq!(detail.body_cache_state, "cached");
    }

    #[test]
    fn normal_account_detail_refetches_cached_html_body() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
        let smtp_adapter = FakeSmtpAdapter::success();
        let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
        sync_recent_headers(
            &connection,
            &vault,
            &adapter,
            SyncRecentHeadersRequest {
                account_id: result.account.id.clone(),
                limit: 10,
            },
            "2026-06-12T00:05:00Z".to_string(),
        )
        .expect("sync headers");
        let message_id: String = connection
            .query_row("SELECT id FROM messages LIMIT 1", [], |row| row.get(0))
            .expect("read message id");
        update_message_body_text_cache(
            &connection,
            &message_id,
            "<html><body><p>Raw cached HTML</p></body></html>",
            "2026-06-12T00:06:00Z",
        )
        .expect("seed html cache");

        let detail = load_message_detail_with_imap_body(
            &connection,
            &vault,
            &adapter,
            &message_id,
            "2026-06-12T00:07:00Z".to_string(),
        )
        .expect("load detail")
        .expect("detail exists");

        assert_eq!(detail.body_text, Some("Body for uid-1".to_string()));
    }

    #[test]
    fn imap_auth_failure_sets_auth_failed_status() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let imap_adapter = FakeImapAdapter::auth_failed();
        let smtp_adapter = FakeSmtpAdapter::success();

        let error = add_manual_imap_account(
            &connection,
            &vault,
            &imap_adapter,
            &smtp_adapter,
            ManualImapAccountRequest {
                imap_password: "bad-password".to_string(),
                ..manual_request()
            },
            "2026-06-12T00:00:00Z".to_string(),
        )
        .expect_err("auth failure");

        assert_eq!(error.code, "imap_auth_failed");
        assert_no_normal_account_created(&connection);
    }

    #[test]
    fn smtp_auth_failure_keeps_receive_account_but_disables_sending() {
        let connection = test_connection();
        let vault = FakeSecretVaultAdapter::default();
        let imap_adapter = FakeImapAdapter::with_connection_success();
        let smtp_adapter = FakeSmtpAdapter::auth_failure();

        let result = add_manual_imap_account(
            &connection,
            &vault,
            &imap_adapter,
            &smtp_adapter,
            manual_request(),
            "2026-06-12T00:00:00Z".to_string(),
        )
        .expect("smtp failure should not block receiving account");

        assert_eq!(result.account.receive_status, "enabled");
        assert_eq!(result.account.send_status, "auth_failed");
        assert!(get_smtp_source_for_account(&connection, &result.account.id)
            .expect("query smtp source")
            .is_some());
    }

    fn seed_manual_account(
        connection: &Connection,
        vault: &FakeSecretVaultAdapter,
        imap_adapter: &FakeImapAdapter,
        smtp_adapter: &FakeSmtpAdapter,
    ) -> AddManualImapAccountResult {
        add_manual_imap_account(
            connection,
            vault,
            imap_adapter,
            smtp_adapter,
            manual_request(),
            "2026-06-12T00:00:00Z".to_string(),
        )
        .expect("seed manual imap")
    }

    fn manual_request() -> ManualImapAccountRequest {
        ManualImapAccountRequest {
            display_name: "Work".to_string(),
            email_address: "work@example.test".to_string(),
            imap_host: "imap.example.test".to_string(),
            imap_port: 993,
            imap_security: "tls".to_string(),
            imap_username: "work@example.test".to_string(),
            imap_password: "app-password".to_string(),
            smtp_host: "smtp.example.test".to_string(),
            smtp_port: 465,
            smtp_security: "tls".to_string(),
            smtp_username: "work@example.test".to_string(),
            smtp_password: "app-password".to_string(),
        }
    }

    fn fake_header(uid: &str, subject: &str) -> ImapMessageHeader {
        ImapMessageHeader {
            provider_message_id: uid.to_string(),
            message_id: Some(format!("{uid}@example.test")),
            in_reply_to: None,
            references: Vec::new(),
            subject: subject.to_string(),
            from_address: "noreply@example.test".to_string(),
            date_received: "2026-06-12T00:05:00Z".to_string(),
            snippet: format!("{subject} snippet"),
            authentication_results: None,
            received_spf: None,
            dkim_signature: None,
            list_id: None,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            precedence: None,
            list_post: None,
            list_help: None,
            feedback_id: None,
        }
    }

    fn test_remote_folders() -> Vec<ImapFolder> {
        vec![
            test_folder("INBOX", "INBOX", "inbox"),
            test_folder("Archive", "Archive", "archive"),
            test_folder("Spam", "Spam", "spam"),
            test_folder("Trash", "Trash", "trash"),
        ]
    }

    fn test_folder(path: &str, display_name: &str, kind: &str) -> ImapFolder {
        ImapFolder {
            provider_folder_id: path.to_string(),
            display_name: display_name.to_string(),
            path: path.to_string(),
            delimiter: "/".to_string(),
            folder_kind: kind.to_string(),
        }
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }
}
