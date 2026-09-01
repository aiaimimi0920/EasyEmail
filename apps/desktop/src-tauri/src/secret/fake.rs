use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::AppError;
use crate::secret::SecretVaultAdapter;

#[derive(Debug, Clone, Default)]
pub struct FakeSecretVaultAdapter {
    secrets: Arc<Mutex<HashMap<String, String>>>,
}

impl SecretVaultAdapter for FakeSecretVaultAdapter {
    fn save_secret(&self, key: &str, value: &str) -> Result<(), AppError> {
        let mut secrets = self.secrets.lock().map_err(|error| {
            AppError::internal("fake_secret_vault_lock_failed", error.to_string())
        })?;
        secrets.insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn load_secret(&self, key: &str) -> Result<Option<String>, AppError> {
        let secrets = self.secrets.lock().map_err(|error| {
            AppError::internal("fake_secret_vault_lock_failed", error.to_string())
        })?;
        Ok(secrets.get(key).cloned())
    }

    fn delete_secret(&self, key: &str) -> Result<(), AppError> {
        let mut secrets = self.secrets.lock().map_err(|error| {
            AppError::internal("fake_secret_vault_lock_failed", error.to_string())
        })?;
        secrets.remove(key);
        Ok(())
    }

    fn exists(&self, key: &str) -> Result<bool, AppError> {
        let secrets = self.secrets.lock().map_err(|error| {
            AppError::internal("fake_secret_vault_lock_failed", error.to_string())
        })?;
        Ok(secrets.contains_key(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_secret_vault_round_trips_without_sqlite() {
        let vault = FakeSecretVaultAdapter::default();

        vault
            .save_secret("secret://imap/account-1", "app-password")
            .expect("save");

        assert!(vault.exists("secret://imap/account-1").expect("exists"));
        assert_eq!(
            vault.load_secret("secret://imap/account-1").expect("load"),
            Some("app-password".to_string())
        );
    }
}
