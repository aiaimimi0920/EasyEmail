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

mod account;
mod action_dispatch;
mod detail;
mod flag_actions;
mod move_actions;
mod support;
mod sync;

pub use account::*;
pub use action_dispatch::*;
pub use detail::*;
pub use flag_actions::*;
pub use move_actions::*;
pub use sync::*;

use flag_actions::apply_remote_flag_action;
use move_actions::{
    apply_archive_action, apply_delete_action, apply_move_action, apply_permanent_delete_action,
};
use support::*;

#[cfg(test)]
use account::normalize_manual_imap_account_request;

#[cfg(test)]
mod tests;
