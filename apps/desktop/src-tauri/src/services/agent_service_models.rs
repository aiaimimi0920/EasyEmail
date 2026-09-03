use serde::{Deserialize, Serialize};

use crate::storage::agent_repository::{AgentMessageRow, AgentThreadRow};
use crate::storage::send_queue_repository::SendQueueRow;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSendTaskRequest {
    pub agent_service_id: String,
    pub sender_account_id: String,
    pub subject: String,
    pub body_text: String,
    pub confirm_restricted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSendTaskResult {
    pub thread: AgentThreadRow,
    pub queue: SendQueueRow,
    pub agent_message: AgentMessageRow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReplyAssociationRequest {
    pub message_id: String,
    pub from_address: String,
    pub in_reply_to_message_id: Option<String>,
    pub references: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentReplyAssociationResult {
    pub status: String,
    pub thread: AgentThreadRow,
    pub agent_message: AgentMessageRow,
}
