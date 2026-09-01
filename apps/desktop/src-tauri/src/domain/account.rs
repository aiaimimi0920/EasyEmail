use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountScope {
    Normal,
    Agent,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    NormalLongLived,
    NormalUpgradedTemp,
    AnonymousVirtual,
    AgentOwned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    Ready,
    Configuring,
    Syncing,
    Degraded,
    Disabled,
    HistoryOnly,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    NotRequired,
    Valid,
    Expired,
    Invalid,
    Missing,
    Refreshing,
    ReauthorizationRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiveStatus {
    Enabled,
    Syncing,
    Backoff,
    AuthFailed,
    ProviderUnavailable,
    Expired,
    Disabled,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SendStatus {
    Enabled,
    Sending,
    QueuedOnly,
    AuthFailed,
    SmtpUnavailable,
    RateLimited,
    Disabled,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub scope: AccountScope,
    pub kind: AccountKind,
    pub display_name: String,
    pub primary_address: Option<String>,
    pub provider_label: Option<String>,
    pub status: AccountStatus,
    pub auth_status: AuthStatus,
    pub receive_status: ReceiveStatus,
    pub send_status: SendStatus,
    pub listed_in_all_accounts: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Account {
    pub fn anonymous_virtual(now: String) -> Self {
        Self {
            id: "acct_anonymous_virtual".to_string(),
            scope: AccountScope::System,
            kind: AccountKind::AnonymousVirtual,
            display_name: "Anonymous Mailbox".to_string(),
            primary_address: None,
            provider_label: None,
            status: AccountStatus::Ready,
            auth_status: AuthStatus::NotRequired,
            receive_status: ReceiveStatus::Enabled,
            send_status: SendStatus::Unsupported,
            listed_in_all_accounts: true,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn agent_owned(display_name: String, address: String, now: String) -> Self {
        Self {
            id: format!("acct_{}", Uuid::new_v4()),
            scope: AccountScope::Agent,
            kind: AccountKind::AgentOwned,
            display_name,
            primary_address: Some(address),
            provider_label: None,
            status: AccountStatus::Configuring,
            auth_status: AuthStatus::Missing,
            receive_status: ReceiveStatus::Disabled,
            send_status: SendStatus::Disabled,
            listed_in_all_accounts: false,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn normal_upgraded_temp(
        address: String,
        provider_label: Option<String>,
        now: String,
    ) -> Self {
        Self {
            id: format!("acct_{}", Uuid::new_v4()),
            scope: AccountScope::Normal,
            kind: AccountKind::NormalUpgradedTemp,
            display_name: address.clone(),
            primary_address: Some(address),
            provider_label,
            status: AccountStatus::Ready,
            auth_status: AuthStatus::NotRequired,
            receive_status: ReceiveStatus::Enabled,
            send_status: SendStatus::Unsupported,
            listed_in_all_accounts: true,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn normal_long_lived(
        display_name: String,
        address: String,
        provider_label: Option<String>,
        now: String,
    ) -> Self {
        Self {
            id: format!("acct_{}", Uuid::new_v4()),
            scope: AccountScope::Normal,
            kind: AccountKind::NormalLongLived,
            display_name,
            primary_address: Some(address),
            provider_label,
            status: AccountStatus::Ready,
            auth_status: AuthStatus::Valid,
            receive_status: ReceiveStatus::Enabled,
            send_status: SendStatus::Unsupported,
            listed_in_all_accounts: true,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_virtual_must_be_system_scope() {
        let account = Account::anonymous_virtual("2026-06-11T00:00:00Z".to_string());

        assert_eq!(account.scope, AccountScope::System);
        assert_eq!(account.kind, AccountKind::AnonymousVirtual);
        assert!(account.listed_in_all_accounts);
        assert_eq!(account.send_status, SendStatus::Unsupported);
    }

    #[test]
    fn agent_owned_is_not_visible_in_normal_all_accounts() {
        let account = Account::agent_owned(
            "Agent Sender".to_string(),
            "agent@example.com".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );

        assert_eq!(account.scope, AccountScope::Agent);
        assert_eq!(account.kind, AccountKind::AgentOwned);
        assert!(!account.listed_in_all_accounts);
    }
}
