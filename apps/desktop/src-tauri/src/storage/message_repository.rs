use std::collections::{BTreeMap, HashSet};

use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde_json::json;
use uuid::Uuid;

use crate::domain::message::{Message, MessageSource};
use crate::easyemail::models::EasyEmailObservedMessage;
use crate::imap::models::ImapMessageHeader;
use crate::storage::account_repository::StoredImapConnectionConfig;
use crate::storage::temp_mailbox_repository::TempMailboxRow;

mod core;
mod imap_ingest;
mod local_state;
mod mailbox_queries;
mod message_detail;
mod newsletters;
mod outgoing;
mod source_mutations;
mod temp_ingest;
mod types;

pub use core::*;
pub use imap_ingest::*;
pub use mailbox_queries::*;
pub use message_detail::*;
pub use newsletters::*;
pub use outgoing::*;
pub use source_mutations::*;
pub use temp_ingest::*;
pub use types::*;

use local_state::{compare_message_time_desc, message_local_state_from_flags};
use newsletters::{
    imap_header_is_newsletter, imap_newsletter_metadata, merge_imap_observed_flags,
    newsletter_subscription_id_from_flags,
};

#[cfg(test)]
mod tests;
