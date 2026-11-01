use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentServiceRow {
    pub id: String,
    pub display_name: String,
    pub email_address: String,
    pub description: Option<String>,
    pub service_kind: String,
    pub trust_level: String,
    pub default_sender_account_id: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewAgentService {
    pub display_name: String,
    pub email_address: String,
    pub description: Option<String>,
    pub service_kind: String,
    pub trust_level: String,
    pub default_sender_account_id: Option<String>,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentThreadRow {
    pub id: String,
    pub agent_service_id: String,
    pub sender_account_id: String,
    pub subject: String,
    pub status: String,
    pub last_outgoing_message_id: Option<String>,
    pub last_incoming_message_id: Option<String>,
    pub correlation_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewAgentThread {
    pub agent_service_id: String,
    pub sender_account_id: String,
    pub subject: String,
    pub correlation_key: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMessageRow {
    pub id: String,
    pub thread_id: String,
    pub message_id: String,
    pub direction: String,
    pub semantic_role: String,
    pub parsed_status: Option<String>,
    pub parsed_payload_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewAgentMessage {
    pub thread_id: String,
    pub message_id: String,
    pub direction: String,
    pub semantic_role: String,
    pub parsed_status: Option<String>,
    pub parsed_payload_json: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentThreadDetail {
    pub thread: AgentThreadRow,
    pub messages: Vec<AgentMessageRow>,
}
