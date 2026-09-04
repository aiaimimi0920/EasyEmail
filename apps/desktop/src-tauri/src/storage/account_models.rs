use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRow {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub display_name: String,
    pub primary_address: Option<String>,
    pub provider_label: Option<String>,
    pub status: String,
    pub auth_status: String,
    pub receive_status: String,
    pub send_status: String,
    pub listed_in_all_accounts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredImapConnectionConfig {
    pub host: String,
    pub port: u16,
    pub security: String,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredSmtpConnectionConfig {
    pub host: String,
    pub port: u16,
    pub security: String,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewNormalImapAccount {
    pub display_name: String,
    pub email_address: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: String,
    pub imap_username: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSmtpSourceForAccount {
    pub account_id: String,
    pub email_address: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: String,
    pub smtp_username: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAgentAccount {
    pub display_name: String,
    pub email_address: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalImapAccountSourceRow {
    pub account: AccountRow,
    pub source_id: String,
    pub source_status: String,
    pub config: StoredImapConnectionConfig,
    pub credential_ref_id: String,
    pub secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpAccountSourceRow {
    pub account: AccountRow,
    pub source_id: String,
    pub address: String,
    pub source_status: String,
    pub config: StoredSmtpConnectionConfig,
    pub credential_ref_id: String,
    pub secret_key: String,
}
