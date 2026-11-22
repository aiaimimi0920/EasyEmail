use rusqlite::{params, Connection, OptionalExtension, Result};

use super::account_models::{AccountRow, NewAgentAccount};
use crate::domain::account::Account;

pub(super) fn map_account_row(row: &rusqlite::Row<'_>) -> Result<AccountRow> {
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
                id, scope, kind, display_name, primary_address, provider_label,
                status, auth_status, receive_status, send_status, listed_in_all_accounts
             FROM accounts
             WHERE id = ?1
               AND deleted_at IS NULL",
            params![account_id],
            map_account_row,
        )
        .optional()
}

pub fn insert_agent_account(connection: &Connection, input: NewAgentAccount) -> Result<AccountRow> {
    let account = Account::agent_owned(input.display_name, input.email_address, input.now);
    let account_id = account.id.clone();
    insert_account(connection, &account)?;
    get_account(connection, &account_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn enum_to_snake<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .expect("serialize enum")
        .as_str()
        .expect("enum serializes to string")
        .to_string()
}
