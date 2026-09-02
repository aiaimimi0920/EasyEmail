use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::error::{ActionRequired, AppError, ErrorCategory, ErrorDto};
use crate::secret::windows::WindowsCredentialManagerVault;
use crate::secret::SecretVaultAdapter;

const DESKTOP_CREDENTIAL_REF_PREFIX: &str = "ref:v1:desktop/";
const DESKTOP_CREDENTIAL_BACKEND: &str = "windows_credential_manager";
const MAX_SECRET_BYTES: usize = 4096;

#[derive(Debug, Deserialize)]
pub struct DesktopCredentialStoreRequest {
    pub credential_kind: String,
    pub auth_method: String,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DesktopCredentialRefDto {
    pub secret_backend: String,
    pub secret_key: String,
    pub credential_kind: String,
    pub auth_method: String,
}

#[derive(Debug, Deserialize)]
pub struct DesktopCredentialDeleteRequest {
    pub secret_key: String,
}

fn validation_error(code: &str, message: &str) -> AppError {
    AppError {
        code: code.to_string(),
        category: ErrorCategory::Validation,
        user_message: message.to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

fn validate_new_secret_key(secret_key: &str) -> Result<(), AppError> {
    let uuid = secret_key
        .strip_prefix(DESKTOP_CREDENTIAL_REF_PREFIX)
        .ok_or_else(|| {
            validation_error(
                "desktop_credential_ref_invalid",
                "The desktop credential reference is invalid.",
            )
        })?;
    uuid::Uuid::parse_str(uuid).map_err(|_| {
        validation_error(
            "desktop_credential_ref_invalid",
            "The desktop credential reference is invalid.",
        )
    })?;
    Ok(())
}

fn store_with_vault<V: SecretVaultAdapter>(
    vault: &V,
    mut request: DesktopCredentialStoreRequest,
) -> Result<DesktopCredentialRefDto, AppError> {
    let credential_kind = request.credential_kind.trim().to_ascii_lowercase();
    let auth_method = request.auth_method.trim().to_ascii_lowercase();
    if credential_kind != "imap_password" || auth_method != "password" {
        request.secret.zeroize();
        return Err(validation_error(
            "desktop_credential_scope_unsupported",
            "Only IMAP password credentials can be stored by this command.",
        ));
    }
    if request.secret.is_empty() || request.secret.len() > MAX_SECRET_BYTES {
        request.secret.zeroize();
        return Err(validation_error(
            "desktop_credential_secret_invalid",
            "The credential must contain from 1 to 4096 bytes.",
        ));
    }

    let secret_key = format!(
        "{DESKTOP_CREDENTIAL_REF_PREFIX}{}",
        uuid::Uuid::new_v4().simple()
    );
    let stored = vault.save_secret(&secret_key, &request.secret);
    request.secret.zeroize();
    stored?;
    Ok(DesktopCredentialRefDto {
        secret_backend: DESKTOP_CREDENTIAL_BACKEND.to_string(),
        secret_key,
        credential_kind,
        auth_method,
    })
}

fn delete_with_vault<V: SecretVaultAdapter>(vault: &V, secret_key: &str) -> Result<(), AppError> {
    validate_new_secret_key(secret_key)?;
    vault.delete_secret(secret_key)
}

#[tauri::command]
pub fn desktop_credential_store(
    request: DesktopCredentialStoreRequest,
) -> Result<DesktopCredentialRefDto, ErrorDto> {
    store_with_vault(&WindowsCredentialManagerVault, request).map_err(ErrorDto::from)
}

#[tauri::command]
pub fn desktop_credential_delete(request: DesktopCredentialDeleteRequest) -> Result<(), ErrorDto> {
    delete_with_vault(&WindowsCredentialManagerVault, request.secret_key.trim())
        .map_err(ErrorDto::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::fake::FakeSecretVaultAdapter;

    #[test]
    fn stores_only_a_versioned_opaque_reference_in_the_result() {
        let vault = FakeSecretVaultAdapter::default();
        let secret = "desktop-vault-canary";
        let result = store_with_vault(
            &vault,
            DesktopCredentialStoreRequest {
                credential_kind: "imap_password".to_string(),
                auth_method: "password".to_string(),
                secret: secret.to_string(),
            },
        )
        .unwrap();

        assert!(result.secret_key.starts_with(DESKTOP_CREDENTIAL_REF_PREFIX));
        assert_eq!(result.secret_backend, DESKTOP_CREDENTIAL_BACKEND);
        assert_eq!(
            vault.load_secret(&result.secret_key).unwrap().as_deref(),
            Some(secret)
        );
        assert!(!serde_json::to_string(&result).unwrap().contains(secret));

        delete_with_vault(&vault, &result.secret_key).unwrap();
        assert!(!vault.exists(&result.secret_key).unwrap());
    }

    #[test]
    fn rejects_broad_scopes_and_arbitrary_delete_targets() {
        let vault = FakeSecretVaultAdapter::default();
        let error = store_with_vault(
            &vault,
            DesktopCredentialStoreRequest {
                credential_kind: "oauth_token".to_string(),
                auth_method: "oauth2".to_string(),
                secret: "desktop-vault-canary".to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "desktop_credential_scope_unsupported");
        assert_eq!(
            delete_with_vault(&vault, "secret://imap/legacy")
                .unwrap_err()
                .code,
            "desktop_credential_ref_invalid"
        );
    }
}
