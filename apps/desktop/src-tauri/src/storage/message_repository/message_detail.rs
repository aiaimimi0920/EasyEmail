use super::*;

pub fn get_message_detail(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<NormalMessageDetailRow>> {
    connection
        .query_row(
            "SELECT
                messages.id AS message_id,
                COALESCE(message_sources.account_id, '') AS account_id,
                messages.thread_key AS thread_key,
                COALESCE(message_sources.received_address, '') AS received_address,
                messages.subject AS subject,
                messages.from_address AS from_address,
                messages.snippet AS snippet,
                COALESCE(messages.date_received, message_sources.last_seen_at, message_sources.first_seen_at, messages.created_at) AS observed_at,
                messages.body_text_cache AS body_text,
                messages.body_html_cache AS body_html,
                messages.body_cache_state AS body_cache_state,
                credential_refs.id AS credential_ref_id,
                credential_refs.secret_key AS secret_key,
                COALESCE(message_sources.flags_json, '{}') AS flags_json
             FROM messages
             LEFT JOIN message_sources ON message_sources.message_id = messages.id
             LEFT JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             LEFT JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
             WHERE messages.id = ?1
               AND messages.deleted_at IS NULL
             ORDER BY message_sources.first_seen_at ASC
             LIMIT 1",
            params![message_id],
            |row| {
                Ok(NormalMessageDetailRow {
                    message_id: row.get("message_id")?,
                    account_id: row.get("account_id")?,
                    thread_key: row.get("thread_key")?,
                    received_address: row.get("received_address")?,
                    subject: row.get("subject")?,
                    from_address: row.get("from_address")?,
                    snippet: row.get("snippet")?,
                    observed_at: row.get("observed_at")?,
                    body_text: row.get("body_text")?,
                    body_html: row.get("body_html")?,
                    body_cache_state: row.get("body_cache_state")?,
                    draft_cc_addresses: draft_address_list_from_flags(
                        &row.get::<_, String>("flags_json")?,
                        "draft_cc_addresses",
                    ),
                    draft_bcc_addresses: draft_address_list_from_flags(
                        &row.get::<_, String>("flags_json")?,
                        "draft_bcc_addresses",
                    ),
                    credential_ref_id: row.get("credential_ref_id")?,
                    secret_key: row.get("secret_key")?,
                    local_state: message_local_state_from_flags(&row.get::<_, String>("flags_json")?),
                })
            },
        )
        .optional()
}

pub fn get_imap_body_fetch_context(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<ImapBodyFetchContextRow>> {
    connection
        .query_row(
            "SELECT
                message_sources.account_id AS account_id,
                message_sources.source_id AS source_id,
                message_sources.folder_id AS folder_id,
                mail_folders.provider_folder_id AS folder_provider_id,
                mail_folders.display_name AS folder_display_name,
                mail_folders.path AS folder_path,
                mail_folders.delimiter AS folder_delimiter,
                mail_folders.folder_kind AS folder_kind,
                COALESCE(message_sources.imap_uid, message_sources.provider_message_id, messages.rfc_message_id, '') AS provider_message_id,
                mailbox_sources.config_json AS config_json,
                credential_refs.secret_key AS secret_key
             FROM messages
             INNER JOIN message_sources ON message_sources.message_id = messages.id
             INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             INNER JOIN mail_folders ON mail_folders.id = message_sources.folder_id
             INNER JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
             WHERE messages.id = ?1
               AND messages.deleted_at IS NULL
               AND mailbox_sources.source_kind = 'imap'
               AND COALESCE(message_sources.imap_uid, message_sources.provider_message_id, messages.rfc_message_id, '') <> ''
             ORDER BY message_sources.first_seen_at ASC
             LIMIT 1",
            params![message_id],
            |row| {
                let config_json: String = row.get("config_json")?;
                let config: StoredImapConnectionConfig =
                    serde_json::from_str(&config_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            config_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(ImapBodyFetchContextRow {
                    account_id: row.get("account_id")?,
                    source_id: row.get("source_id")?,
                    folder_id: row.get("folder_id")?,
                    folder_provider_id: row.get("folder_provider_id")?,
                    folder_display_name: row.get("folder_display_name")?,
                    folder_path: row.get("folder_path")?,
                    folder_delimiter: row.get("folder_delimiter")?,
                    folder_kind: row.get("folder_kind")?,
                    provider_message_id: row.get("provider_message_id")?,
                    config,
                    secret_key: row.get("secret_key")?,
                })
            },
        )
        .optional()
}

pub fn get_imap_message_action_context(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<ImapMessageActionContextRow>> {
    connection
        .query_row(
            "SELECT
                message_sources.account_id AS account_id,
                message_sources.source_id AS source_id,
                message_sources.folder_id AS folder_id,
                mail_folders.provider_folder_id AS folder_provider_id,
                mail_folders.display_name AS folder_display_name,
                mail_folders.path AS folder_path,
                mail_folders.delimiter AS folder_delimiter,
                mail_folders.folder_kind AS folder_kind,
                COALESCE(message_sources.imap_uid, message_sources.provider_message_id, messages.rfc_message_id, '') AS provider_message_id,
                mailbox_sources.config_json AS config_json,
                credential_refs.secret_key AS secret_key
             FROM messages
             INNER JOIN message_sources ON message_sources.message_id = messages.id
             INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             INNER JOIN mail_folders ON mail_folders.id = message_sources.folder_id
             INNER JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
             WHERE messages.id = ?1
               AND messages.deleted_at IS NULL
               AND mailbox_sources.source_kind = 'imap'
               AND COALESCE(message_sources.imap_uid, message_sources.provider_message_id, messages.rfc_message_id, '') <> ''
             ORDER BY message_sources.first_seen_at ASC
             LIMIT 1",
            params![message_id],
            |row| {
                let config_json: String = row.get("config_json")?;
                let config: StoredImapConnectionConfig =
                    serde_json::from_str(&config_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            config_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(ImapMessageActionContextRow {
                    account_id: row.get("account_id")?,
                    source_id: row.get("source_id")?,
                    folder_id: row.get("folder_id")?,
                    folder_provider_id: row.get("folder_provider_id")?,
                    folder_display_name: row.get("folder_display_name")?,
                    folder_path: row.get("folder_path")?,
                    folder_delimiter: row.get("folder_delimiter")?,
                    folder_kind: row.get("folder_kind")?,
                    provider_message_id: row.get("provider_message_id")?,
                    config,
                    secret_key: row.get("secret_key")?,
                })
            },
        )
        .optional()
}

pub fn update_message_body_text_cache(
    connection: &Connection,
    message_id: &str,
    body_text: &str,
    now: &str,
) -> Result<()> {
    update_message_body_cache(connection, message_id, body_text, None, now)
}

pub fn update_message_body_cache(
    connection: &Connection,
    message_id: &str,
    body_text: &str,
    body_html: Option<&str>,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE messages
         SET body_text_cache = ?1,
             body_html_cache = ?2,
             body_cache_state = 'cached',
             updated_at = ?3
         WHERE id = ?4
           AND deleted_at IS NULL",
        params![body_text, body_html, now, message_id],
    )?;
    Ok(())
}

fn draft_address_list_from_flags(flags_json: &str, key: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(flags_json)
        .ok()
        .and_then(|value| value.get(key).cloned())
        .and_then(|value| value.as_array().cloned())
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}
