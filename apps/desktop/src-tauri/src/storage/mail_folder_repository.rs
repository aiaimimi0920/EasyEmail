use rusqlite::{params, Connection, OptionalExtension, Result};
use uuid::Uuid;

use crate::imap::models::ImapFolder;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailFolderRow {
    pub id: String,
    pub account_id: String,
    pub source_id: String,
    pub provider_folder_id: String,
    pub display_name: String,
    pub path: String,
    pub delimiter: Option<String>,
    pub folder_kind: String,
    pub last_seen_uid: Option<String>,
    pub sync_cursor: Option<String>,
}

pub fn upsert_mail_folder(
    connection: &Connection,
    account_id: &str,
    source_id: &str,
    folder: &ImapFolder,
    now: &str,
) -> Result<MailFolderRow> {
    let existing_id: Option<String> = connection
        .query_row(
            "SELECT id
             FROM mail_folders
             WHERE source_id = ?1
               AND provider_folder_id = ?2",
            params![source_id, folder.provider_folder_id],
            |row| row.get(0),
        )
        .optional()?;

    let folder_id = existing_id.unwrap_or_else(|| format!("fld_{}", Uuid::new_v4()));
    connection.execute(
        "INSERT INTO mail_folders (
            id,
            account_id,
            source_id,
            provider_folder_id,
            display_name,
            path,
            delimiter,
            folder_kind,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
        ON CONFLICT(source_id, provider_folder_id) DO UPDATE SET
            display_name = excluded.display_name,
            path = excluded.path,
            delimiter = excluded.delimiter,
            folder_kind = excluded.folder_kind,
            updated_at = excluded.updated_at",
        params![
            folder_id,
            account_id,
            source_id,
            folder.provider_folder_id,
            folder.display_name,
            folder.path,
            folder.delimiter,
            folder.folder_kind,
            now,
        ],
    )?;

    get_mail_folder(connection, &folder_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_mail_folder(connection: &Connection, folder_id: &str) -> Result<Option<MailFolderRow>> {
    connection
        .query_row(
            "SELECT
                id,
                account_id,
                source_id,
                provider_folder_id,
                display_name,
                path,
                delimiter,
                folder_kind,
                last_seen_uid,
                sync_cursor
             FROM mail_folders
             WHERE id = ?1",
            params![folder_id],
            map_mail_folder_row,
        )
        .optional()
}

pub fn list_mail_folders_for_source(
    connection: &Connection,
    source_id: &str,
) -> Result<Vec<MailFolderRow>> {
    let mut statement = connection.prepare(
        "SELECT
            id,
            account_id,
            source_id,
            provider_folder_id,
            display_name,
            path,
            delimiter,
            folder_kind,
            last_seen_uid,
            sync_cursor
         FROM mail_folders
         WHERE source_id = ?1
         ORDER BY folder_kind DESC, display_name ASC",
    )?;

    let rows = statement.query_map(params![source_id], map_mail_folder_row)?;
    rows.collect()
}

fn map_mail_folder_row(row: &rusqlite::Row<'_>) -> Result<MailFolderRow> {
    Ok(MailFolderRow {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        source_id: row.get("source_id")?,
        provider_folder_id: row.get("provider_folder_id")?,
        display_name: row.get("display_name")?,
        path: row.get("path")?,
        delimiter: row.get("delimiter")?,
        folder_kind: row.get("folder_kind")?,
        last_seen_uid: row.get("last_seen_uid")?,
        sync_cursor: row.get("sync_cursor")?,
    })
}
