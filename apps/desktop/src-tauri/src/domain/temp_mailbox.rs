use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TempVisibilityState {
    Anonymous,
    Upgraded,
    Archived,
    Hidden,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TempLifecycleState {
    Active,
    Expiring,
    Expired,
    ReceiveUnavailable,
    ProviderUnavailable,
    HistoryOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TempMailbox {
    pub id: String,
    pub email_address: String,
    pub provider_id: String,
    pub provider_label: String,
    pub domain: Option<String>,
    pub local_part: Option<String>,
    pub easyemail_mailbox_id: Option<String>,
    pub visibility_state: TempVisibilityState,
    pub lifecycle_state: TempLifecycleState,
    pub lease_expires_at: Option<String>,
    pub upgraded_account_id: Option<String>,
    pub raw_provider_snapshot_json: String,
    pub created_at: String,
    pub updated_at: String,
}

impl TempMailbox {
    pub fn new_anonymous(
        email_address: String,
        provider_id: String,
        provider_label: String,
        now: String,
    ) -> Self {
        Self {
            id: format!("temp_{}", Uuid::new_v4()),
            email_address,
            provider_id,
            provider_label,
            domain: None,
            local_part: None,
            easyemail_mailbox_id: None,
            visibility_state: TempVisibilityState::Anonymous,
            lifecycle_state: TempLifecycleState::Active,
            lease_expires_at: None,
            upgraded_account_id: None,
            raw_provider_snapshot_json: "{}".to_string(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn from_easyemail(
        email_address: String,
        provider_id: String,
        provider_label: String,
        easyemail_mailbox_id: Option<String>,
        lease_expires_at: Option<String>,
        raw_provider_snapshot_json: String,
        now: String,
    ) -> Self {
        Self {
            id: format!("temp_{}", Uuid::new_v4()),
            email_address,
            provider_id,
            provider_label,
            domain: None,
            local_part: None,
            easyemail_mailbox_id,
            visibility_state: TempVisibilityState::Anonymous,
            lifecycle_state: TempLifecycleState::Active,
            lease_expires_at,
            upgraded_account_id: None,
            raw_provider_snapshot_json,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_mailbox_default_visibility_is_anonymous() {
        let mailbox = TempMailbox::new_anonymous(
            "code@example.test".to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );

        assert_eq!(mailbox.visibility_state, TempVisibilityState::Anonymous);
        assert_eq!(mailbox.lifecycle_state, TempLifecycleState::Active);
        assert_eq!(mailbox.upgraded_account_id, None);
    }
}
