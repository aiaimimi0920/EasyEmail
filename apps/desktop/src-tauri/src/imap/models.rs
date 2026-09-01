use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImapConnectionProfile {
    pub host: String,
    pub port: u16,
    pub security: String,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImapConnectionTestResult {
    pub authenticated: bool,
    pub capability_summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImapFolder {
    pub provider_folder_id: String,
    pub display_name: String,
    pub path: String,
    pub delimiter: String,
    pub folder_kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImapMessageHeader {
    pub provider_message_id: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    pub from_address: String,
    pub date_received: String,
    pub snippet: String,
    pub authentication_results: Option<String>,
    pub received_spf: Option<String>,
    pub dkim_signature: Option<String>,
    pub list_id: Option<String>,
    pub list_unsubscribe: Option<String>,
    pub list_unsubscribe_post: Option<String>,
    pub precedence: Option<String>,
    pub list_post: Option<String>,
    pub list_help: Option<String>,
    pub feedback_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImapMessageBody {
    pub text: String,
    pub html: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImapMessageMoveResult {
    pub provider_message_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImapMessageFlag {
    Seen,
    Flagged,
    Deleted,
}

impl ImapMessageFlag {
    pub fn as_imap_atom(self) -> &'static str {
        match self {
            Self::Seen => "\\Seen",
            Self::Flagged => "\\Flagged",
            Self::Deleted => "\\Deleted",
        }
    }
}
