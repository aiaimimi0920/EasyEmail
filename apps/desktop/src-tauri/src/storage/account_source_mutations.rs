use rusqlite::{params, Connection, Result};
use serde_json::json;
use uuid::Uuid;

use super::account_crud_repository::{get_account, insert_account};
use super::account_models::{
    AccountRow, NewNormalImapAccount, NewSmtpSourceForAccount, StoredImapConnectionConfig,
    StoredSmtpConnectionConfig,
};
use crate::domain::account::Account;

pub fn insert_normal_imap_account(
    connection: &Connection,
    input: NewNormalImapAccount,
) -> Result<(AccountRow, String)> {
    let account = Account::normal_long_lived(
        input.display_name,
        input.email_address.clone(),
        Some("Manual IMAP".to_string()),
        input.now.clone(),
    );
    let account_id = account.id.clone();
    insert_account(connection, &account)?;

    let source_id = format!("src_{}", Uuid::new_v4());
    let config = StoredImapConnectionConfig {
        host: input.imap_host,
        port: input.imap_port,
        security: input.imap_security,
        username: input.imap_username,
    };
    let config_json = json!(config).to_string();
    connection.execute(
        "INSERT INTO mailbox_sources (
            id, account_id, source_kind, address, provider_id, config_json,
            status, created_at, updated_at
        ) VALUES (?1, ?2, 'imap', ?3, ?4, ?5, 'ready', ?6, ?6)",
        params![
            source_id,
            account_id,
            input.email_address,
            config.host,
            config_json,
            input.now,
        ],
    )?;

    let account =
        get_account(connection, &account_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    Ok((account, source_id))
}

pub fn insert_smtp_source_for_account(
    connection: &Connection,
    input: NewSmtpSourceForAccount,
) -> Result<String> {
    let source_id = format!("src_{}", Uuid::new_v4());
    let config = StoredSmtpConnectionConfig {
        host: input.smtp_host,
        port: input.smtp_port,
        security: input.smtp_security,
        username: input.smtp_username,
    };
    let config_json = json!(config).to_string();
    connection.execute(
        "INSERT INTO mailbox_sources (
            id, account_id, source_kind, address, provider_id, config_json,
            status, created_at, updated_at
        ) VALUES (?1, ?2, 'smtp', ?3, ?4, ?5, 'ready', ?6, ?6)",
        params![
            source_id,
            input.account_id,
            input.email_address,
            config.host,
            config_json,
            input.now,
        ],
    )?;
    Ok(source_id)
}

pub fn mark_account_send_enabled(
    connection: &Connection,
    account_id: &str,
    now: &str,
) -> Result<()> {
    mark_account_send_status(connection, account_id, "enabled", now)
}

pub fn mark_account_send_status(
    connection: &Connection,
    account_id: &str,
    send_status: &str,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE accounts
         SET send_status = ?1,
             updated_at = ?2
         WHERE id = ?3
           AND deleted_at IS NULL",
        params![send_status, now, account_id],
    )?;
    Ok(())
}

pub fn update_mailbox_source_credential_ref(
    connection: &Connection,
    source_id: &str,
    credential_ref_id: &str,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE mailbox_sources
         SET credential_ref_id = ?1,
             updated_at = ?2
         WHERE id = ?3",
        params![credential_ref_id, now, source_id],
    )?;
    Ok(())
}

pub fn mark_imap_source_sync_success(
    connection: &Connection,
    source_id: &str,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE mailbox_sources
         SET status = 'ready',
             last_sync_at = ?1,
             last_success_at = ?1,
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = ?1
         WHERE id = ?2",
        params![now, source_id],
    )?;
    Ok(())
}
