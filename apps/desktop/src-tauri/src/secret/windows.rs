use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::secret::SecretVaultAdapter;

#[derive(Debug, Clone, Default)]
pub struct WindowsCredentialManagerVault;

impl SecretVaultAdapter for WindowsCredentialManagerVault {
    fn save_secret(&self, key: &str, value: &str) -> Result<(), AppError> {
        platform::save_secret(key, value)
    }

    fn load_secret(&self, key: &str) -> Result<Option<String>, AppError> {
        platform::load_secret(key)
    }

    fn delete_secret(&self, key: &str) -> Result<(), AppError> {
        platform::delete_secret(key)
    }

    fn exists(&self, key: &str) -> Result<bool, AppError> {
        Ok(self.load_secret(key)?.is_some())
    }
}

#[cfg(windows)]
mod platform {
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };
    use zeroize::Zeroizing;

    use super::*;

    const TARGET_PREFIX: &str = "EasyEmailAM:";

    pub fn save_secret(key: &str, value: &str) -> Result<(), AppError> {
        let mut target = wide_target_name(key);
        let mut username = wide_string("EasyEmailAM");
        let mut blob = Zeroizing::new(value.as_bytes().to_vec());
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: blob.len().try_into().map_err(|_| {
                credential_error(
                    "windows_credential_secret_too_large",
                    "Secret is too large for Windows Credential Manager.",
                    None,
                    false,
                )
            })?,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: username.as_mut_ptr(),
            ..Default::default()
        };

        let written = unsafe { CredWriteW(&credential, 0) };
        if written == 0 {
            return Err(last_credential_error(
                "windows_credential_save_failed",
                "The password could not be stored in Windows Credential Manager.",
                true,
            ));
        }

        Ok(())
    }

    pub fn load_secret(key: &str) -> Result<Option<String>, AppError> {
        let target = wide_target_name(key);
        let mut credential: *mut CREDENTIALW = null_mut();
        let read = unsafe {
            CredReadW(
                target.as_ptr(),
                CRED_TYPE_GENERIC,
                0,
                &mut credential as *mut *mut CREDENTIALW,
            )
        };

        if read == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(credential_error(
                "windows_credential_load_failed",
                "The password could not be loaded from Windows Credential Manager.",
                Some(format!("CredReadW failed with Windows error {code}")),
                true,
            ));
        }

        let result = unsafe {
            let credential_ref = &*credential;
            let bytes = std::slice::from_raw_parts(
                credential_ref.CredentialBlob,
                credential_ref.CredentialBlobSize as usize,
            );
            let copied = Zeroizing::new(bytes.to_vec());
            std::str::from_utf8(copied.as_slice())
                .map(str::to_owned)
                .map_err(|error| {
                    credential_error(
                        "windows_credential_decode_failed",
                        "The stored password could not be decoded.",
                        Some(error.to_string()),
                        false,
                    )
                })
        };
        unsafe { CredFree(credential.cast()) };

        result.map(Some)
    }

    pub fn delete_secret(key: &str) -> Result<(), AppError> {
        let target = wide_target_name(key);
        let deleted = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if deleted == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                return Ok(());
            }
            return Err(credential_error(
                "windows_credential_delete_failed",
                "The password could not be deleted from Windows Credential Manager.",
                Some(format!("CredDeleteW failed with Windows error {code}")),
                true,
            ));
        }
        Ok(())
    }

    fn wide_target_name(key: &str) -> Vec<u16> {
        wide_string(&format!("{TARGET_PREFIX}{key}"))
    }

    fn wide_string(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_credential_error(code: &str, message: &str, retryable: bool) -> AppError {
        let win32 = unsafe { GetLastError() };
        credential_error(
            code,
            message,
            Some(format!("Windows Credential Manager error {win32}")),
            retryable,
        )
    }

    fn credential_error(
        code: &str,
        message: &str,
        technical_message: Option<String>,
        retryable: bool,
    ) -> AppError {
        AppError {
            code: code.to_string(),
            category: ErrorCategory::Storage,
            user_message: message.to_string(),
            technical_message,
            retryable,
            action_required: if retryable {
                ActionRequired::Retry
            } else {
                ActionRequired::None
            },
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "adapter": "windows_credential_manager" })),
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn save_secret(_key: &str, _value: &str) -> Result<(), AppError> {
        Err(unavailable())
    }

    pub fn load_secret(_key: &str) -> Result<Option<String>, AppError> {
        Err(unavailable())
    }

    pub fn delete_secret(_key: &str) -> Result<(), AppError> {
        Err(unavailable())
    }

    fn unavailable() -> AppError {
        AppError {
            code: "windows_credential_manager_unavailable".to_string(),
            category: ErrorCategory::Unsupported,
            user_message: "Windows Credential Manager is only available on Windows.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "adapter": "windows_credential_manager" })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use zeroize::Zeroizing;

    #[test]
    fn windows_credential_manager_adapter_exists() {
        let _adapter = WindowsCredentialManagerVault;
    }

    #[cfg(windows)]
    #[test]
    fn credential_survives_fresh_adapter_instances() {
        let key = format!("ref:v1:desktop/test-{}", uuid::Uuid::new_v4().simple());
        let secret = Zeroizing::new(format!(
            "credential-restart-canary-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let stored = {
            let vault = WindowsCredentialManagerVault;
            vault.save_secret(&key, secret.as_str()).is_ok()
        };
        let loaded = {
            let vault = WindowsCredentialManagerVault;
            Zeroizing::new(vault.load_secret(&key).ok().flatten().unwrap_or_default())
        };
        let persisted = stored && loaded.as_str() == secret.as_str();
        let cleanup = WindowsCredentialManagerVault;
        let deleted = cleanup.delete_secret(&key).is_ok();

        assert!(
            stored,
            "Windows Credential Manager rejected the isolated test credential."
        );
        assert!(
            persisted,
            "A fresh vault adapter could not resolve the stored credential."
        );
        assert!(
            deleted,
            "The isolated test credential could not be removed."
        );
        assert!(!cleanup.exists(&key).unwrap_or(true));
    }
}
