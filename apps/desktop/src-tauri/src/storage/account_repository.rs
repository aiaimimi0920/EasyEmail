use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::domain::account::Account;

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

fn map_account_row(row: &rusqlite::Row<'_>) -> Result<AccountRow> {
    Ok(AccountRow {
        id: row.get("id")?,
        scope: row.get("scope")?,
        kind: row.get("kind")?,
        display_name: row.get("display_name")?,
        primary_address: row.get("primary_address")?,
        provider_label: row.get("provider_label")?,
        status: row.get("status")?,
        auth_status: row.get("auth_status")?,
        receive_status: row.get("receive_status")?,
        send_status: row.get("send_status")?,
        listed_in_all_accounts: row.get::<_, i64>("listed_in_all_accounts")? == 1,
    })
}

pub fn insert_account(connection: &Connection, account: &Account) -> Result<()> {
    connection.execute(
        "INSERT INTO accounts (
            id,
            scope,
            kind,
            display_name,
            primary_address,
            provider_label,
            status,
            auth_status,
            receive_status,
            send_status,
            listed_in_all_accounts,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            account.id,
            enum_to_snake(&account.scope),
            enum_to_snake(&account.kind),
            account.display_name,
            account.primary_address,
            account.provider_label,
            enum_to_snake(&account.status),
            enum_to_snake(&account.auth_status),
            enum_to_snake(&account.receive_status),
            enum_to_snake(&account.send_status),
            if account.listed_in_all_accounts {
                1_i64
            } else {
                0_i64
            },
            account.created_at,
            account.updated_at,
        ],
    )?;

    Ok(())
}

pub fn ensure_anonymous_virtual_account(connection: &Connection, now: String) -> Result<String> {
    let existing: Option<String> = connection
        .query_row(
            "SELECT id FROM accounts WHERE kind = 'anonymous_virtual' AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(id) = existing {
        return Ok(id);
    }

    let account = Account::anonymous_virtual(now);
    let id = account.id.clone();
    insert_account(connection, &account)?;
    Ok(id)
}

pub fn get_account(connection: &Connection, account_id: &str) -> Result<Option<AccountRow>> {
    connection
        .query_row(
            "SELECT
                id,
                scope,
                kind,
                display_name,
                primary_address,
                provider_label,
                status,
                auth_status,
                receive_status,
                send_status,
                listed_in_all_accounts
             FROM accounts
             WHERE id = ?1
               AND deleted_at IS NULL",
            params![account_id],
            map_account_row,
        )
        .optional()
}

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
            id,
            account_id,
            source_kind,
            address,
            provider_id,
            config_json,
            status,
            created_at,
            updated_at
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
            id,
            account_id,
            source_kind,
            address,
            provider_id,
            config_json,
            status,
            created_at,
            updated_at
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

pub fn insert_agent_account(connection: &Connection, input: NewAgentAccount) -> Result<AccountRow> {
    let account = Account::agent_owned(input.display_name, input.email_address, input.now);
    let account_id = account.id.clone();
    insert_account(connection, &account)?;
    get_account(connection, &account_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
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

pub fn get_normal_imap_source_for_account(
    connection: &Connection,
    account_id: &str,
) -> Result<Option<NormalImapAccountSourceRow>> {
    connection
        .query_row(
            "SELECT
                accounts.id AS id,
                accounts.scope AS scope,
                accounts.kind AS kind,
                accounts.display_name AS display_name,
                accounts.primary_address AS primary_address,
                accounts.provider_label AS provider_label,
                accounts.status AS status,
                accounts.auth_status AS auth_status,
                accounts.receive_status AS receive_status,
                accounts.send_status AS send_status,
                accounts.listed_in_all_accounts AS listed_in_all_accounts,
                mailbox_sources.id AS source_id,
                mailbox_sources.status AS source_status,
                mailbox_sources.config_json AS config_json,
                credential_refs.id AS credential_ref_id,
                credential_refs.secret_key AS secret_key
             FROM accounts
             INNER JOIN mailbox_sources ON mailbox_sources.account_id = accounts.id
             INNER JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
             WHERE accounts.id = ?1
               AND accounts.scope = 'normal'
               AND accounts.kind = 'normal_long_lived'
               AND accounts.deleted_at IS NULL
               AND mailbox_sources.source_kind = 'imap'
             ORDER BY mailbox_sources.created_at ASC
             LIMIT 1",
            params![account_id],
            |row| {
                let config_json: String = row.get("config_json")?;
                let config: StoredImapConnectionConfig = serde_json::from_str(&config_json)
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            config_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(NormalImapAccountSourceRow {
                    account: map_account_row(row)?,
                    source_id: row.get("source_id")?,
                    source_status: row.get("source_status")?,
                    config,
                    credential_ref_id: row.get("credential_ref_id")?,
                    secret_key: row.get("secret_key")?,
                })
            },
        )
        .optional()
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

pub fn get_smtp_source_for_account(
    connection: &Connection,
    account_id: &str,
) -> Result<Option<SmtpAccountSourceRow>> {
    connection
        .query_row(
            "SELECT
                accounts.id AS id,
                accounts.scope AS scope,
                accounts.kind AS kind,
                accounts.display_name AS display_name,
                accounts.primary_address AS primary_address,
                accounts.provider_label AS provider_label,
                accounts.status AS status,
                accounts.auth_status AS auth_status,
                accounts.receive_status AS receive_status,
                accounts.send_status AS send_status,
                accounts.listed_in_all_accounts AS listed_in_all_accounts,
                mailbox_sources.id AS source_id,
                COALESCE(mailbox_sources.address, accounts.primary_address, '') AS address,
                mailbox_sources.status AS source_status,
                mailbox_sources.config_json AS config_json,
                credential_refs.id AS credential_ref_id,
                credential_refs.secret_key AS secret_key
             FROM accounts
             INNER JOIN mailbox_sources ON mailbox_sources.account_id = accounts.id
             INNER JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
             WHERE accounts.id = ?1
               AND accounts.deleted_at IS NULL
               AND mailbox_sources.source_kind = 'smtp'
             ORDER BY mailbox_sources.created_at ASC
             LIMIT 1",
            params![account_id],
            |row| {
                let config_json: String = row.get("config_json")?;
                let config: StoredSmtpConnectionConfig = serde_json::from_str(&config_json)
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            config_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(SmtpAccountSourceRow {
                    account: map_account_row(row)?,
                    source_id: row.get("source_id")?,
                    address: row.get("address")?,
                    source_status: row.get("source_status")?,
                    config,
                    credential_ref_id: row.get("credential_ref_id")?,
                    secret_key: row.get("secret_key")?,
                })
            },
        )
        .optional()
}

pub fn list_normal_accounts(connection: &Connection) -> Result<Vec<AccountRow>> {
    let mut statement = connection.prepare(
        "SELECT
            id,
            scope,
            kind,
            display_name,
            primary_address,
            provider_label,
            status,
            auth_status,
            receive_status,
            send_status,
            listed_in_all_accounts
         FROM accounts
         WHERE deleted_at IS NULL
           AND listed_in_all_accounts = 1
           AND (scope = 'normal' OR kind = 'anonymous_virtual')
         ORDER BY created_at ASC, id ASC",
    )?;

    let rows = statement.query_map([], map_account_row)?;
    rows.collect()
}

pub fn list_agent_accounts(connection: &Connection) -> Result<Vec<AccountRow>> {
    let mut statement = connection.prepare(
        "SELECT
            id,
            scope,
            kind,
            display_name,
            primary_address,
            provider_label,
            status,
            auth_status,
            receive_status,
            send_status,
            listed_in_all_accounts
         FROM accounts
         WHERE deleted_at IS NULL
           AND scope = 'agent'
         ORDER BY created_at ASC, id ASC",
    )?;

    let rows = statement.query_map([], map_account_row)?;
    rows.collect()
}

pub fn enum_to_snake<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .expect("serialize enum")
        .as_str()
        .expect("enum serializes to string")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::account::Account;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    #[test]
    fn ensure_anonymous_virtual_account_is_idempotent() {
        let connection = test_connection();

        let first =
            ensure_anonymous_virtual_account(&connection, "2026-06-11T00:00:00Z".to_string())
                .expect("first ensure");
        let second =
            ensure_anonymous_virtual_account(&connection, "2026-06-11T00:01:00Z".to_string())
                .expect("second ensure");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM accounts WHERE kind = 'anonymous_virtual'",
                [],
                |row| row.get(0),
            )
            .expect("count anonymous accounts");

        assert_eq!(first, "acct_anonymous_virtual");
        assert_eq!(first, second);
        assert_eq!(count, 1);
    }

    #[test]
    fn normal_account_query_excludes_agent_accounts() {
        let connection = test_connection();
        ensure_anonymous_virtual_account(&connection, "2026-06-11T00:00:00Z".to_string())
            .expect("ensure anonymous");

        let agent = Account::agent_owned(
            "Agent Sender".to_string(),
            "agent@example.test".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );
        insert_account(&connection, &agent).expect("insert agent account");

        let rows = list_normal_accounts(&connection).expect("list normal accounts");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "acct_anonymous_virtual");
        assert_eq!(rows[0].kind, "anonymous_virtual");
    }
}
