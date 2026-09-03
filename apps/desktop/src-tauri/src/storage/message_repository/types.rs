use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistObservedMessagesResult {
    pub fetched_count: usize,
    pub inserted_count: usize,
    pub inserted_message_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageLocalState {
    pub is_read: bool,
    pub is_starred: bool,
    pub is_archived: bool,
    pub is_important: bool,
    pub local_folder: String,
    pub labels: Vec<String>,
    pub newsletter_subscription_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnonymousMessageRow {
    pub message_id: String,
    pub temp_mailbox_id: String,
    pub received_address: String,
    pub provider_label: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub lifecycle_state: String,
    pub local_state: MessageLocalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotedAccountMessageRow {
    pub account_id: String,
    pub message_id: String,
    pub temp_mailbox_id: String,
    pub received_address: String,
    pub provider_label: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub lifecycle_state: String,
    pub local_state: MessageLocalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalAccountMessageRow {
    pub account_id: String,
    pub message_id: String,
    pub thread_key: Option<String>,
    pub source_id: String,
    pub folder_id: String,
    pub provider_message_id: String,
    pub received_address: String,
    pub provider_label: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub local_state: MessageLocalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalMessageDetailRow {
    pub message_id: String,
    pub account_id: String,
    pub thread_key: Option<String>,
    pub received_address: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub body_cache_state: String,
    pub draft_cc_addresses: Vec<String>,
    pub draft_bcc_addresses: Vec<String>,
    pub credential_ref_id: Option<String>,
    pub secret_key: Option<String>,
    pub local_state: MessageLocalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewsletterSubscriptionRow {
    pub id: String,
    pub list_id: String,
    pub sender_address: String,
    pub name: String,
    pub received_message_count: usize,
    pub unread_message_count: usize,
    pub last_received_at: String,
    pub unsubscribe_methods: Vec<String>,
    pub spam: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImapBodyFetchContextRow {
    pub account_id: String,
    pub source_id: String,
    pub folder_id: String,
    pub folder_provider_id: String,
    pub folder_display_name: String,
    pub folder_path: String,
    pub folder_delimiter: Option<String>,
    pub folder_kind: String,
    pub provider_message_id: String,
    pub config: StoredImapConnectionConfig,
    pub secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImapMessageActionContextRow {
    pub account_id: String,
    pub source_id: String,
    pub folder_id: String,
    pub folder_provider_id: String,
    pub folder_display_name: String,
    pub folder_path: String,
    pub folder_delimiter: Option<String>,
    pub folder_kind: String,
    pub provider_message_id: String,
    pub config: StoredImapConnectionConfig,
    pub secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAssociationMessageRow {
    pub message_id: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub body_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingMessageRow {
    pub id: String,
    pub account_id: String,
    pub source_id: String,
    pub target_address: String,
    pub subject: String,
    pub body_text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewOutgoingMessage {
    pub account_id: String,
    pub source_id: String,
    pub from_address: String,
    pub target_address: String,
    pub subject: String,
    pub body_text: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewLocalDraftMessage {
    pub draft_id: Option<String>,
    pub account_id: String,
    pub source_id: String,
    pub from_address: String,
    pub target_address: String,
    pub cc_addresses: Vec<String>,
    pub bcc_addresses: Vec<String>,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub now: String,
}
