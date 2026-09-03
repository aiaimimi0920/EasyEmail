use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualImapAccountRequest {
    pub display_name: String,
    pub email_address: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: String,
    pub imap_username: String,
    pub imap_password: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: String,
    pub smtp_username: String,
    pub smtp_password: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddManualImapAccountResult {
    pub account: AccountRow,
    pub credential: CredentialRefRow,
}

pub fn add_manual_imap_account<V, I, S>(
    connection: &Connection,
    vault: &V,
    imap_adapter: &I,
    smtp_adapter: &S,
    request: ManualImapAccountRequest,
    now: String,
) -> Result<AddManualImapAccountResult, AppError>
where
    V: SecretVaultAdapter,
    I: ImapAdapter,
    S: SmtpAdapter,
{
    let request = normalize_manual_imap_account_request(request)?;
    let imap_profile = imap_profile_from_request(&request);
    let smtp_profile = smtp_profile_from_request(&request);
    imap_adapter.test_connection(&imap_profile, &request.imap_password)?;
    let smtp_test_result = smtp_adapter.test_connection(&smtp_profile, &request.smtp_password);

    let (account, source_id) = insert_normal_imap_account(
        connection,
        NewNormalImapAccount {
            display_name: request.display_name.clone(),
            email_address: request.email_address.clone(),
            imap_host: request.imap_host.clone(),
            imap_port: request.imap_port,
            imap_security: request.imap_security.clone(),
            imap_username: request.imap_username.clone(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;

    let secret_key = format!("secret://imap/{}", account.id);
    let credential = insert_credential_ref(
        connection,
        NewCredentialRef {
            owner_account_id: account.id.clone(),
            source_id: source_id.clone(),
            secret_backend: "secret_vault".to_string(),
            secret_key: secret_key.clone(),
            credential_kind: "imap_password".to_string(),
            auth_method: "password".to_string(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    vault.save_secret(&secret_key, &request.imap_password)?;
    update_mailbox_source_credential_ref(connection, &source_id, &credential.id, &now)
        .map_err(storage_error)?;

    let smtp_source_id = insert_smtp_source_for_account(
        connection,
        NewSmtpSourceForAccount {
            account_id: account.id.clone(),
            email_address: request.email_address,
            smtp_host: request.smtp_host,
            smtp_port: request.smtp_port,
            smtp_security: request.smtp_security,
            smtp_username: request.smtp_username,
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let smtp_secret_key = format!("secret://smtp/{}", account.id);
    let smtp_credential = insert_credential_ref(
        connection,
        NewCredentialRef {
            owner_account_id: account.id.clone(),
            source_id: smtp_source_id.clone(),
            secret_backend: "secret_vault".to_string(),
            secret_key: smtp_secret_key.clone(),
            credential_kind: "smtp_password".to_string(),
            auth_method: "password".to_string(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    vault.save_secret(&smtp_secret_key, &request.smtp_password)?;
    update_mailbox_source_credential_ref(connection, &smtp_source_id, &smtp_credential.id, &now)
        .map_err(storage_error)?;
    if let Err(error) = smtp_test_result {
        mark_account_send_status(
            connection,
            &account.id,
            smtp_send_status_for_error(&error),
            &now,
        )
        .map_err(storage_error)?;
    } else {
        mark_account_send_enabled(connection, &account.id, &now).map_err(storage_error)?;
    }
    let account = crate::storage::account_repository::get_account(connection, &account.id)
        .map_err(storage_error)?
        .ok_or_else(|| {
            AppError::internal(
                "normal_account_missing_after_update",
                "Account missing after SMTP setup.",
            )
        })?;

    Ok(AddManualImapAccountResult {
        account,
        credential,
    })
}

pub(super) fn normalize_manual_imap_account_request(
    request: ManualImapAccountRequest,
) -> Result<ManualImapAccountRequest, AppError> {
    let normalized = ManualImapAccountRequest {
        display_name: request.display_name.trim().to_string(),
        email_address: request.email_address.trim().to_ascii_lowercase(),
        imap_host: request.imap_host.trim().to_ascii_lowercase(),
        imap_port: request.imap_port,
        imap_security: request.imap_security.trim().to_ascii_lowercase(),
        imap_username: request.imap_username.trim().to_string(),
        imap_password: request.imap_password,
        smtp_host: request.smtp_host.trim().to_ascii_lowercase(),
        smtp_port: request.smtp_port,
        smtp_security: request.smtp_security.trim().to_ascii_lowercase(),
        smtp_username: request.smtp_username.trim().to_string(),
        smtp_password: request.smtp_password,
    };

    if normalized.display_name.is_empty()
        || normalized.email_address.is_empty()
        || normalized.imap_host.is_empty()
        || normalized.imap_username.is_empty()
        || normalized.imap_password.is_empty()
        || normalized.smtp_host.is_empty()
        || normalized.smtp_username.is_empty()
        || normalized.smtp_password.is_empty()
    {
        return Err(AppError {
            code: "manual_imap_account_invalid".to_string(),
            category: ErrorCategory::Validation,
            user_message:
                "Enter mailbox identity, IMAP settings, SMTP settings, usernames, and app passwords."
                    .to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::EditSettings,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }

    if !matches!(
        normalized.imap_security.as_str(),
        "tls" | "ssl" | "starttls"
    ) || !matches!(normalized.smtp_security.as_str(), "tls" | "starttls")
    {
        return Err(AppError {
            code: "manual_mail_security_invalid".to_string(),
            category: ErrorCategory::Validation,
            user_message: "IMAP and SMTP must use TLS or STARTTLS.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::EditSettings,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }

    Ok(normalized)
}

pub(super) fn imap_profile_from_request(
    request: &ManualImapAccountRequest,
) -> ImapConnectionProfile {
    ImapConnectionProfile {
        host: request.imap_host.clone(),
        port: request.imap_port,
        security: request.imap_security.clone(),
        username: request.imap_username.clone(),
    }
}

pub(super) fn smtp_profile_from_request(
    request: &ManualImapAccountRequest,
) -> SmtpConnectionProfile {
    SmtpConnectionProfile {
        host: request.smtp_host.clone(),
        port: request.smtp_port,
        security: request.smtp_security.clone(),
        username: request.smtp_username.clone(),
    }
}

pub(super) fn smtp_send_status_for_error(error: &AppError) -> &'static str {
    match error.category {
        ErrorCategory::Auth => "auth_failed",
        _ => "smtp_unavailable",
    }
}
