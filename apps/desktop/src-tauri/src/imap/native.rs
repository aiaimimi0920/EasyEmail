mod connection;
mod folders;
mod headers;
mod html;
mod message_body;
mod move_protocol;
#[cfg(test)]
mod tests;

use crate::error::AppError;
use crate::imap::adapter::ImapAdapter;
use crate::imap::models::{
    ImapConnectionProfile, ImapConnectionTestResult, ImapFolder, ImapMessageBody, ImapMessageFlag,
    ImapMessageHeader, ImapMessageMoveResult,
};

use connection::{connect_session, imap_error, logout_quietly};
use folders::{classify_folder_kind, default_inbox_folder};
use headers::{fetch_to_header, HEADER_FETCH_QUERY};
use message_body::decoded_message_body;
use move_protocol::{parse_copyuid_target_uid, quote_imap_mailbox, validate_imap_uid};

#[derive(Debug, Clone, Default)]
pub struct NativeImapAdapter;

impl ImapAdapter for NativeImapAdapter {
    fn test_connection(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
    ) -> Result<ImapConnectionTestResult, AppError> {
        let mut session = connect_session(profile, secret)?;
        let capabilities = session
            .capabilities()
            .map_err(|error| imap_error("imap_capabilities_failed", error))?;
        let summary = format!(
            "{} capabilities; IMAP4rev1={}",
            capabilities.len(),
            capabilities.has_str("IMAP4rev1")
        );
        logout_quietly(session);

        Ok(ImapConnectionTestResult {
            authenticated: true,
            capability_summary: summary,
        })
    }

    fn discover_folders(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
    ) -> Result<Vec<ImapFolder>, AppError> {
        let mut session = connect_session(profile, secret)?;
        let names = session
            .list(None, Some("*"))
            .map_err(|error| imap_error("imap_list_folders_failed", error))?;
        let mut folders = names
            .iter()
            .map(|name| {
                let path = name.name().to_string();
                ImapFolder {
                    provider_folder_id: path.clone(),
                    display_name: path.clone(),
                    path: path.clone(),
                    delimiter: name.delimiter().unwrap_or("/").to_string(),
                    folder_kind: classify_folder_kind(&path).to_string(),
                }
            })
            .collect::<Vec<_>>();
        logout_quietly(session);

        if folders.is_empty() {
            folders.push(default_inbox_folder());
        }
        Ok(folders)
    }

    fn fetch_recent_headers(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        limit: usize,
    ) -> Result<Vec<ImapMessageHeader>, AppError> {
        let mut session = connect_session(profile, secret)?;
        let mailbox = session
            .select(&folder.path)
            .map_err(|error| imap_error("imap_select_folder_failed", error))?;
        if mailbox.exists == 0 || limit == 0 {
            logout_quietly(session);
            return Ok(Vec::new());
        }

        let limit = limit.min(mailbox.exists as usize) as u32;
        let start = mailbox.exists.saturating_sub(limit).saturating_add(1);
        let sequence = format!("{start}:{}", mailbox.exists);
        let fetches = session
            .fetch(sequence, HEADER_FETCH_QUERY)
            .map_err(|error| imap_error("imap_fetch_headers_failed", error))?;
        let mut headers = fetches
            .iter()
            .filter_map(fetch_to_header)
            .collect::<Vec<_>>();
        headers.reverse();
        logout_quietly(session);
        Ok(headers)
    }

    fn fetch_incremental(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        _cursor: Option<String>,
    ) -> Result<Vec<ImapMessageHeader>, AppError> {
        self.fetch_recent_headers(profile, secret, folder, 100)
    }

    fn fetch_message_body(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        provider_message_id: &str,
    ) -> Result<Option<ImapMessageBody>, AppError> {
        let mut session = connect_session(profile, secret)?;
        session
            .select(&folder.path)
            .map_err(|error| imap_error("imap_select_folder_failed", error))?;
        let fetches = session
            .uid_fetch(provider_message_id, "BODY.PEEK[]")
            .map_err(|error| imap_error("imap_fetch_body_failed", error))?;
        let body = fetches
            .iter()
            .find_map(|fetch| fetch.body().or_else(|| fetch.text()))
            .and_then(decoded_message_body);
        logout_quietly(session);
        Ok(body)
    }

    fn set_message_flag(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        provider_message_id: &str,
        flag: ImapMessageFlag,
        enabled: bool,
    ) -> Result<(), AppError> {
        let uid = validate_imap_uid(provider_message_id)?;
        let mut session = connect_session(profile, secret)?;
        session
            .select(&folder.path)
            .map_err(|error| imap_error("imap_select_folder_failed", error))?;
        let operation = if enabled {
            "+FLAGS.SILENT"
        } else {
            "-FLAGS.SILENT"
        };
        session
            .uid_store(&uid, format!("{operation} ({})", flag.as_imap_atom()))
            .map_err(|error| imap_error("imap_store_flags_failed", error))?;
        logout_quietly(session);
        Ok(())
    }

    fn move_message(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        source_folder: &ImapFolder,
        provider_message_id: &str,
        target_folder: &ImapFolder,
    ) -> Result<ImapMessageMoveResult, AppError> {
        if source_folder.path == target_folder.path {
            return Ok(ImapMessageMoveResult {
                provider_message_id: None,
            });
        }

        let uid = validate_imap_uid(provider_message_id)?;
        let mut session = connect_session(profile, secret)?;
        let capabilities = session
            .capabilities()
            .map_err(|error| imap_error("imap_capabilities_failed", error))?;
        let supports_move = capabilities.has_str("MOVE");
        let supports_uidplus = capabilities.has_str("UIDPLUS");
        session
            .select(&source_folder.path)
            .map_err(|error| imap_error("imap_select_folder_failed", error))?;

        let target_provider_message_id = if supports_move {
            let (response, _) = session
                .run(format!(
                    "UID MOVE {} {}",
                    uid,
                    quote_imap_mailbox(&target_folder.path)?
                ))
                .map_err(|error| imap_error("imap_move_message_failed", error))?;
            parse_copyuid_target_uid(&response, &uid)
        } else {
            let (response, _) = session
                .run(format!(
                    "UID COPY {} {}",
                    uid,
                    quote_imap_mailbox(&target_folder.path)?
                ))
                .map_err(|error| imap_error("imap_copy_message_failed", error))?;
            let target_uid = parse_copyuid_target_uid(&response, &uid);
            session
                .uid_store(&uid, "+FLAGS.SILENT (\\Deleted)")
                .map_err(|error| imap_error("imap_mark_moved_source_deleted_failed", error))?;
            if supports_uidplus {
                session
                    .uid_expunge(&uid)
                    .map_err(|error| imap_error("imap_uid_expunge_failed", error))?;
            }
            target_uid
        };

        logout_quietly(session);
        Ok(ImapMessageMoveResult {
            provider_message_id: target_provider_message_id,
        })
    }
}
