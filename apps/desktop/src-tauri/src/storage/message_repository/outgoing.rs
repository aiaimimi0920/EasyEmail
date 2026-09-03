use super::*;

pub fn get_message_for_agent_association(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<AgentAssociationMessageRow>> {
    connection
        .query_row(
            "SELECT
                id AS message_id,
                subject,
                from_address,
                snippet,
                body_text_cache AS body_text
             FROM messages
             WHERE id = ?1
               AND deleted_at IS NULL",
            params![message_id],
            |row| {
                Ok(AgentAssociationMessageRow {
                    message_id: row.get("message_id")?,
                    subject: row.get("subject")?,
                    from_address: row.get("from_address")?,
                    snippet: row.get("snippet")?,
                    body_text: row.get("body_text")?,
                })
            },
        )
        .optional()
}

pub fn insert_outgoing_message(
    connection: &Connection,
    message: NewOutgoingMessage,
) -> Result<OutgoingMessageRow> {
    let NewOutgoingMessage {
        account_id,
        source_id,
        from_address,
        target_address,
        subject,
        body_text,
        now,
    } = message;
    let message_id = format!("msg_{}", Uuid::new_v4());
    let snippet: String = body_text.chars().take(180).collect();
    connection.execute(
        "INSERT INTO messages (
            id,
            subject,
            from_address,
            snippet,
            body_text_cache,
            body_cache_state,
            classification,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'cached', 'outgoing', ?6, ?6)",
        params![message_id, subject, from_address, snippet, body_text, now,],
    )?;
    connection.execute(
        "INSERT INTO message_sources (
            id,
            message_id,
            source_id,
            account_id,
            received_address,
            first_seen_at,
            last_seen_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            format!("msrc_{}", Uuid::new_v4()),
            message_id,
            source_id,
            account_id,
            target_address,
            now,
        ],
    )?;

    Ok(OutgoingMessageRow {
        id: message_id,
        account_id,
        source_id,
        target_address,
        subject,
        body_text,
        created_at: now,
    })
}

pub fn upsert_local_draft_message(
    connection: &Connection,
    draft: NewLocalDraftMessage,
) -> Result<OutgoingMessageRow> {
    let NewLocalDraftMessage {
        draft_id,
        account_id,
        source_id,
        from_address,
        target_address,
        cc_addresses,
        bcc_addresses,
        subject,
        body_text,
        body_html,
        now,
    } = draft;
    let transaction = connection.unchecked_transaction()?;
    let message_id = match draft_id {
        Some(candidate_id) if existing_message_is_local_draft(&transaction, &candidate_id)? => {
            candidate_id
        }
        Some(candidate_id) if !message_exists(&transaction, &candidate_id)? => candidate_id,
        _ => format!("msg_{}", Uuid::new_v4()),
    };
    let snippet: String = body_text.chars().take(180).collect();
    let flags_json = json!({
        "local_folder": "drafts",
        "read": true,
        "draft_cc_addresses": cc_addresses,
        "draft_bcc_addresses": bcc_addresses,
    })
    .to_string();

    transaction.execute(
        "INSERT INTO messages (
            id,
            subject,
            from_address,
            snippet,
            body_text_cache,
            body_html_cache,
            body_cache_state,
            classification,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'cached', 'outgoing', ?7, ?7)
        ON CONFLICT(id) DO UPDATE SET
            subject = excluded.subject,
            from_address = excluded.from_address,
            snippet = excluded.snippet,
            body_text_cache = excluded.body_text_cache,
            body_html_cache = excluded.body_html_cache,
            body_cache_state = 'cached',
            classification = 'outgoing',
            updated_at = excluded.updated_at,
            deleted_at = NULL",
        params![
            message_id,
            subject,
            from_address,
            snippet,
            body_text,
            body_html,
            now,
        ],
    )?;

    let existing_source_id: Option<String> = transaction
        .query_row(
            "SELECT id FROM message_sources WHERE message_id = ?1 LIMIT 1",
            params![message_id],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(existing_source_id) = existing_source_id {
        transaction.execute(
            "UPDATE message_sources
             SET source_id = ?1,
                 account_id = ?2,
                 received_address = ?3,
                 flags_json = ?4,
                 last_seen_at = ?5
             WHERE id = ?6",
            params![
                source_id,
                account_id,
                target_address,
                flags_json,
                now,
                existing_source_id,
            ],
        )?;
    } else {
        transaction.execute(
            "INSERT INTO message_sources (
                id,
                message_id,
                source_id,
                account_id,
                received_address,
                flags_json,
                first_seen_at,
                last_seen_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                format!("msrc_{}", Uuid::new_v4()),
                message_id,
                source_id,
                account_id,
                target_address,
                flags_json,
                now,
            ],
        )?;
    }
    transaction.commit()?;

    Ok(OutgoingMessageRow {
        id: message_id,
        account_id,
        source_id,
        target_address,
        subject,
        body_text,
        created_at: now,
    })
}

pub fn delete_local_draft_message(
    connection: &Connection,
    message_id: &str,
    now: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE messages
         SET deleted_at = ?1,
             updated_at = ?1
         WHERE id = ?2
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM message_sources
             WHERE message_sources.message_id = messages.id
               AND json_extract(message_sources.flags_json, '$.local_folder') = 'drafts'
           )",
        params![now, message_id],
    )?;
    Ok(changed > 0)
}

pub fn convert_scheduled_send_to_local_draft(
    connection: &Connection,
    message_id: &str,
    cc_addresses: &[String],
    bcc_addresses: &[String],
    now: &str,
) -> Result<bool> {
    let flags_json = json!({
        "local_folder": "drafts",
        "read": true,
        "draft_cc_addresses": cc_addresses,
        "draft_bcc_addresses": bcc_addresses,
    })
    .to_string();

    let changed = connection.execute(
        "UPDATE message_sources
         SET flags_json = ?1,
             last_seen_at = ?2
         WHERE message_id = ?3
           AND EXISTS (
             SELECT 1
             FROM messages
             INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             WHERE messages.id = message_sources.message_id
               AND messages.classification = 'outgoing'
               AND messages.deleted_at IS NULL
               AND mailbox_sources.source_kind = 'smtp'
           )",
        params![flags_json, now, message_id],
    )?;

    Ok(changed > 0)
}

fn message_exists(connection: &Connection, message_id: &str) -> Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?1)",
        params![message_id],
        |row| row.get(0),
    )
}

fn existing_message_is_local_draft(connection: &Connection, message_id: &str) -> Result<bool> {
    connection.query_row(
        "SELECT EXISTS(
            SELECT 1
            FROM messages
            INNER JOIN message_sources ON message_sources.message_id = messages.id
            WHERE messages.id = ?1
              AND json_extract(message_sources.flags_json, '$.local_folder') = 'drafts'
        )",
        params![message_id],
        |row| row.get(0),
    )
}
