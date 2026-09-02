pub mod fake;
pub mod windows;

use crate::error::AppError;

pub trait SecretVaultAdapter: Send + Sync {
    fn save_secret(&self, key: &str, value: &str) -> Result<(), AppError>;
    fn load_secret(&self, key: &str) -> Result<Option<String>, AppError>;
    fn delete_secret(&self, key: &str) -> Result<(), AppError>;
    fn exists(&self, key: &str) -> Result<bool, AppError>;
}
