use super::*;

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

pub(super) fn body_fetch_context_folder_to_imap(context: &ImapBodyFetchContextRow) -> ImapFolder {
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

pub(super) fn cached_body_needs_refetch(body: &str) -> bool {
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
