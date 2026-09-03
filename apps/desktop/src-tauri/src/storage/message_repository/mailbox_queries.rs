use super::*;

pub fn list_anonymous_messages(connection: &Connection) -> Result<Vec<AnonymousMessageRow>> {
    list_anonymous_messages_with_options(connection, false)
}

pub fn list_anonymous_messages_with_options(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<AnonymousMessageRow>> {
    let mut statement = connection.prepare(
        "SELECT
            messages.id AS message_id,
            temp_mailboxes.id AS temp_mailbox_id,
            COALESCE(message_sources.received_address, temp_mailboxes.email_address) AS received_address,
            temp_mailboxes.provider_label AS provider_label,
            messages.subject AS subject,
            messages.from_address AS from_address,
            messages.snippet AS snippet,
            COALESCE(messages.date_received, message_sources.first_seen_at, messages.created_at) AS observed_at,
            temp_mailboxes.lifecycle_state AS lifecycle_state,
            message_sources.flags_json AS flags_json
         FROM messages
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         INNER JOIN temp_mailboxes ON temp_mailboxes.id = message_sources.temp_mailbox_id
         WHERE temp_mailboxes.visibility_state = 'anonymous'
           AND messages.deleted_at IS NULL
           AND (?1 = 1 OR COALESCE(json_extract(message_sources.flags_json, '$.archived'), 0) = 0)
         ORDER BY observed_at DESC, messages.id DESC",
    )?;

    let mut rows = statement
        .query_map(params![include_archived], |row| {
            Ok(AnonymousMessageRow {
                message_id: row.get("message_id")?,
                temp_mailbox_id: row.get("temp_mailbox_id")?,
                received_address: row.get("received_address")?,
                provider_label: row.get("provider_label")?,
                subject: row.get("subject")?,
                from_address: row.get("from_address")?,
                snippet: row.get("snippet")?,
                observed_at: row.get("observed_at")?,
                lifecycle_state: row.get("lifecycle_state")?,
                local_state: message_local_state_from_flags(&row.get::<_, String>("flags_json")?),
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    rows.sort_by(|left, right| {
        compare_message_time_desc(
            &left.observed_at,
            &left.message_id,
            &right.observed_at,
            &right.message_id,
        )
    });

    Ok(rows)
}

pub fn list_promoted_account_messages(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<PromotedAccountMessageRow>> {
    list_promoted_account_messages_with_options(connection, account_id, false)
}

pub fn list_promoted_account_messages_with_options(
    connection: &Connection,
    account_id: &str,
    include_archived: bool,
) -> Result<Vec<PromotedAccountMessageRow>> {
    let mut statement = connection.prepare(
        "SELECT
            temp_mailboxes.upgraded_account_id AS account_id,
            messages.id AS message_id,
            temp_mailboxes.id AS temp_mailbox_id,
            COALESCE(message_sources.received_address, temp_mailboxes.email_address) AS received_address,
            temp_mailboxes.provider_label AS provider_label,
            messages.subject AS subject,
            messages.from_address AS from_address,
            messages.snippet AS snippet,
            COALESCE(messages.date_received, message_sources.first_seen_at, messages.created_at) AS observed_at,
            temp_mailboxes.lifecycle_state AS lifecycle_state,
            message_sources.flags_json AS flags_json
         FROM messages
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         INNER JOIN temp_mailboxes ON temp_mailboxes.id = message_sources.temp_mailbox_id
         WHERE temp_mailboxes.visibility_state = 'upgraded'
           AND temp_mailboxes.upgraded_account_id = ?1
           AND messages.deleted_at IS NULL
           AND (?2 = 1 OR COALESCE(json_extract(message_sources.flags_json, '$.archived'), 0) = 0)
         ORDER BY observed_at DESC, messages.id DESC",
    )?;

    let mut rows = statement
        .query_map(params![account_id, include_archived], |row| {
            Ok(PromotedAccountMessageRow {
                account_id: row.get("account_id")?,
                message_id: row.get("message_id")?,
                temp_mailbox_id: row.get("temp_mailbox_id")?,
                received_address: row.get("received_address")?,
                provider_label: row.get("provider_label")?,
                subject: row.get("subject")?,
                from_address: row.get("from_address")?,
                snippet: row.get("snippet")?,
                observed_at: row.get("observed_at")?,
                lifecycle_state: row.get("lifecycle_state")?,
                local_state: message_local_state_from_flags(&row.get::<_, String>("flags_json")?),
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    rows.sort_by(|left, right| {
        compare_message_time_desc(
            &left.observed_at,
            &left.message_id,
            &right.observed_at,
            &right.message_id,
        )
    });

    Ok(rows)
}

pub fn list_normal_account_messages(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<NormalAccountMessageRow>> {
    list_normal_account_messages_with_options(connection, account_id, false)
}

pub fn list_normal_account_messages_with_options(
    connection: &Connection,
    account_id: &str,
    include_archived: bool,
) -> Result<Vec<NormalAccountMessageRow>> {
    let mut statement = connection.prepare(
        "SELECT
            message_sources.account_id AS account_id,
            messages.id AS message_id,
            messages.thread_key AS thread_key,
            message_sources.source_id AS source_id,
            COALESCE(message_sources.folder_id, '') AS folder_id,
            COALESCE(message_sources.provider_message_id, message_sources.imap_uid, messages.rfc_message_id, '') AS provider_message_id,
            COALESCE(
                CASE WHEN mailbox_sources.source_kind = 'smtp' THEN message_sources.received_address END,
                mailbox_sources.address,
                accounts.primary_address,
                message_sources.account_id,
                ''
            ) AS received_address,
            COALESCE(accounts.provider_label, mailbox_sources.provider_id, 'Manual IMAP') AS provider_label,
            messages.subject AS subject,
            messages.from_address AS from_address,
            messages.snippet AS snippet,
            COALESCE(outgoing_queue.sent_at, outgoing_queue.next_retry_at, messages.date_received, message_sources.last_seen_at, message_sources.first_seen_at, messages.created_at) AS observed_at,
            CASE
                WHEN mailbox_sources.source_kind = 'smtp' AND outgoing_queue.status = 'sent' THEN '{\"local_folder\":\"sent\",\"read\":true}'
                WHEN mailbox_sources.source_kind = 'smtp' AND outgoing_queue.status = 'queued' THEN '{\"local_folder\":\"sent\",\"read\":true,\"labels\":[\"未发送\"]}'
                ELSE message_sources.flags_json
            END AS flags_json
         FROM messages
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
         INNER JOIN accounts ON accounts.id = message_sources.account_id
         LEFT JOIN send_queue AS outgoing_queue
           ON outgoing_queue.message_id = messages.id
          AND (
            outgoing_queue.status = 'sent'
            OR (
              outgoing_queue.status = 'queued'
              AND outgoing_queue.next_retry_at IS NOT NULL
            )
          )
         WHERE message_sources.account_id = ?1
           AND (
             mailbox_sources.source_kind = 'imap'
             OR (
               mailbox_sources.source_kind = 'smtp'
               AND messages.classification = 'outgoing'
               AND (
                 outgoing_queue.id IS NOT NULL
                 OR json_extract(message_sources.flags_json, '$.local_folder') = 'drafts'
               )
             )
           )
           AND messages.deleted_at IS NULL
           AND (?2 = 1 OR COALESCE(json_extract(message_sources.flags_json, '$.archived'), 0) = 0)
         ORDER BY observed_at DESC, messages.id DESC",
    )?;

    let mut rows = statement
        .query_map(params![account_id, include_archived], |row| {
            Ok(NormalAccountMessageRow {
                account_id: row.get("account_id")?,
                message_id: row.get("message_id")?,
                thread_key: row.get("thread_key")?,
                source_id: row.get("source_id")?,
                folder_id: row.get("folder_id")?,
                provider_message_id: row.get("provider_message_id")?,
                received_address: row.get("received_address")?,
                provider_label: row.get("provider_label")?,
                subject: row.get("subject")?,
                from_address: row.get("from_address")?,
                snippet: row.get("snippet")?,
                observed_at: row.get("observed_at")?,
                local_state: message_local_state_from_flags(&row.get::<_, String>("flags_json")?),
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    rows.sort_by(|left, right| {
        compare_message_time_desc(
            &left.observed_at,
            &left.message_id,
            &right.observed_at,
            &right.message_id,
        )
    });

    Ok(rows)
}
