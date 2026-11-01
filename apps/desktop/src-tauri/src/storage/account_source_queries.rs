use rusqlite::{params, Connection, OptionalExtension, Result};

use super::account_crud_repository::map_account_row;
use super::account_models::{NormalImapAccountSourceRow, SmtpAccountSourceRow};

fn parse_config<T: serde::de::DeserializeOwned>(value: String) -> Result<T> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
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
                Ok(NormalImapAccountSourceRow {
                    account: map_account_row(row)?,
                    source_id: row.get("source_id")?,
                    source_status: row.get("source_status")?,
                    config: parse_config(row.get("config_json")?)?,
                    credential_ref_id: row.get("credential_ref_id")?,
                    secret_key: row.get("secret_key")?,
                })
            },
        )
        .optional()
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
                Ok(SmtpAccountSourceRow {
                    account: map_account_row(row)?,
                    source_id: row.get("source_id")?,
                    address: row.get("address")?,
                    source_status: row.get("source_status")?,
                    config: parse_config(row.get("config_json")?)?,
                    credential_ref_id: row.get("credential_ref_id")?,
                    secret_key: row.get("secret_key")?,
                })
            },
        )
        .optional()
}
