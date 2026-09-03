use super::*;

pub fn ensure_easyemail_temp_source(
    connection: &Connection,
    temp_mailbox: &TempMailboxRow,
    now: &str,
) -> Result<String> {
    if let Some(source_id) = temp_mailbox.source_id.as_ref() {
        return Ok(source_id.clone());
    }

    let source_id = format!("src_{}", Uuid::new_v4());
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO mailbox_sources (
            id,
            source_kind,
            address,
            provider_id,
            status,
            created_at,
            updated_at
         ) VALUES (?1, 'easyemail_temp', ?2, ?3, 'ready', ?4, ?4)",
        params![
            source_id,
            temp_mailbox.email_address,
            temp_mailbox.provider_id,
            now,
        ],
    )?;
    let changed = transaction.execute(
        "UPDATE temp_mailboxes
         SET source_id = ?1,
             updated_at = ?2
         WHERE id = ?3
           AND source_id IS NULL",
        params![source_id, now, temp_mailbox.id],
    )?;

    if changed == 0 {
        let existing_source_id: String = transaction.query_row(
            "SELECT source_id
             FROM temp_mailboxes
             WHERE id = ?1
               AND source_id IS NOT NULL",
            params![temp_mailbox.id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "DELETE FROM mailbox_sources WHERE id = ?1",
            params![source_id],
        )?;
        transaction.commit()?;
        return Ok(existing_source_id);
    }

    transaction.commit()?;

    Ok(source_id)
}

pub fn persist_observed_messages(
    connection: &Connection,
    temp_mailbox: &TempMailboxRow,
    source_id: &str,
    messages: &[EasyEmailObservedMessage],
    now: &str,
) -> Result<PersistObservedMessagesResult> {
    // One transaction for the whole batch. This loop issues two to three
    // statements per message, and in autocommit each one is a separate commit
    // with its own fsync.
    let transaction = connection.unchecked_transaction()?;
    let connection = &transaction;

    let mut inserted_count = 0;
    let mut inserted_message_ids = Vec::new();

    for observed in messages {
        // A failed lookup must not be treated as "row absent": that would
        // insert a duplicate message instead of updating the existing one.
        let existing: Option<String> = connection
            .query_row(
                "SELECT message_id
                 FROM message_sources
                 WHERE temp_mailbox_id = ?1
                   AND easyemail_message_id = ?2",
                params![temp_mailbox.id, observed.id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(message_id) = existing {
            connection.execute(
                "UPDATE message_sources
                 SET last_seen_at = ?1
                 WHERE message_id = ?2
                   AND temp_mailbox_id = ?3
                   AND easyemail_message_id = ?4",
                params![now, message_id, temp_mailbox.id, observed.id],
            )?;
            continue;
        }

        let message_id = format!("msg_{}", Uuid::new_v4());
        let subject = observed
            .subject
            .clone()
            .unwrap_or_else(|| "(no subject)".to_string());
        let from_address = observed
            .sender
            .clone()
            .unwrap_or_else(|| "unknown@easyemail.local".to_string());
        let snippet = observed_snippet(observed);

        connection.execute(
            "INSERT INTO messages (
                id,
                rfc_message_id,
                subject,
                from_address,
                date_received,
                snippet,
                body_text_cache,
                body_html_cache,
                body_cache_state,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'cached', ?9, ?9)",
            params![
                message_id,
                observed.id,
                subject,
                from_address,
                observed.observed_at,
                snippet,
                observed.text_body,
                observed.html_body,
                now,
            ],
        )?;

        connection.execute(
            "INSERT INTO message_sources (
                id,
                message_id,
                source_id,
                temp_mailbox_id,
                provider_message_id,
                easyemail_message_id,
                received_address,
                first_seen_at,
                last_seen_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?7)",
            params![
                format!("msrc_{}", Uuid::new_v4()),
                message_id,
                source_id,
                temp_mailbox.id,
                observed.id,
                temp_mailbox.email_address,
                now,
            ],
        )?;
        inserted_count += 1;
        inserted_message_ids.push(message_id);
    }

    transaction.commit()?;

    Ok(PersistObservedMessagesResult {
        fetched_count: messages.len(),
        inserted_count,
        inserted_message_ids,
    })
}

fn observed_snippet(observed: &EasyEmailObservedMessage) -> String {
    let source = observed
        .text_body
        .as_deref()
        .or(observed.html_body.as_deref())
        .or(observed.subject.as_deref())
        .unwrap_or("");
    source.chars().take(180).collect()
}
