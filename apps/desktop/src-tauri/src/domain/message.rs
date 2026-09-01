use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub rfc_message_id: Option<String>,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageSource {
    pub id: String,
    pub message_id: String,
    pub source_id: String,
    pub account_id: Option<String>,
    pub temp_mailbox_id: Option<String>,
    pub provider_message_id: Option<String>,
    pub received_address: Option<String>,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

impl Message {
    pub fn new(subject: String, from_address: String, snippet: String, now: String) -> Self {
        Self {
            id: format!("msg_{}", Uuid::new_v4()),
            rfc_message_id: None,
            subject,
            from_address,
            snippet,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}
