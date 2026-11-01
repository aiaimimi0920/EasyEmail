use rusqlite::{Connection, Result};

use super::account_crud_repository::map_account_row;
use super::account_models::AccountRow;

pub fn list_normal_accounts(connection: &Connection) -> Result<Vec<AccountRow>> {
    let mut statement = connection.prepare(
        "SELECT
            id, scope, kind, display_name, primary_address, provider_label,
            status, auth_status, receive_status, send_status, listed_in_all_accounts
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
            id, scope, kind, display_name, primary_address, provider_label,
            status, auth_status, receive_status, send_status, listed_in_all_accounts
         FROM accounts
         WHERE deleted_at IS NULL
           AND scope = 'agent'
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement.query_map([], map_account_row)?;
    rows.collect()
}
