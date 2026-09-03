use super::*;

pub fn persist_imap_headers(
    connection: &Connection,
    account_id: &str,
    source_id: &str,
    folder_id: &str,
    headers: &[ImapMessageHeader],
    now: &str,
) -> Result<PersistObservedMessagesResult> {
    // One transaction for the whole batch. This loop issues four to six
    // statements per header, and in autocommit each one is a separate commit
    // with its own fsync.
    let transaction = connection.unchecked_transaction()?;
    let connection = &transaction;

    let mut inserted_count = 0;
    let mut inserted_message_ids = Vec::new();

    for header in headers {
        let computed_thread_key = imap_message_thread_key(connection, header)?;
        // A failed lookup must not be treated as "row absent": that would
        // insert a duplicate message instead of updating the existing one.
        let existing_message: Option<(String, Option<String>, Option<String>)> = connection
            .query_row(
                "SELECT message_sources.message_id,
                        messages.rfc_message_id,
                        messages.thread_key
                 FROM message_sources
                 INNER JOIN messages ON messages.id = message_sources.message_id
                 WHERE message_sources.source_id = ?1
                   AND message_sources.folder_id = ?2
                   AND message_sources.imap_uid = ?3",
                params![source_id, folder_id, header.provider_message_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        if let Some((message_id, existing_rfc_message_id, existing_thread_key)) = existing_message {
            let security_flags = imap_security_flags(header);
            let rfc_message_id = header.message_id.clone().or(existing_rfc_message_id);
            let thread_key = if header.message_id.is_none()
                && header.in_reply_to.is_none()
                && header.references.is_empty()
            {
                existing_thread_key.or(computed_thread_key)
            } else {
                computed_thread_key.or(existing_thread_key)
            };
            connection.execute(
                "UPDATE messages
                 SET subject = ?1,
                     from_address = ?2,
                     date_received = ?3,
                     snippet = ?4,
                     security_flags = ?5,
                     rfc_message_id = ?6,
                     thread_key = ?7,
                     updated_at = ?8
                 WHERE id = ?9",
                params![
                    header.subject,
                    header.from_address,
                    header.date_received,
                    header.snippet,
                    security_flags,
                    rfc_message_id,
                    thread_key,
                    now,
                    message_id,
                ],
            )?;
            connection.execute(
                "UPDATE message_sources
                 SET last_seen_at = ?1
                 WHERE message_id = ?2
                   AND source_id = ?3
                   AND folder_id = ?4
                   AND imap_uid = ?5",
                params![
                    now,
                    message_id,
                    source_id,
                    folder_id,
                    header.provider_message_id,
                ],
            )?;
            merge_imap_observed_flags(
                connection,
                source_id,
                folder_id,
                &header.provider_message_id,
                header,
                now,
            )?;
            continue;
        }

        let message_id = format!("msg_{}", Uuid::new_v4());
        let security_flags = imap_security_flags(header);
        let flags_json = imap_initial_flags(connection, folder_id, header)?;
        let thread_key = computed_thread_key;
        connection.execute(
            "INSERT INTO messages (
                id,
                rfc_message_id,
                subject,
                from_address,
                date_received,
                snippet,
                security_flags,
                body_cache_state,
                thread_key,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'headers_only', ?8, ?9, ?9)",
            params![
                message_id,
                header.message_id,
                header.subject,
                header.from_address,
                header.date_received,
                header.snippet,
                security_flags,
                thread_key,
                now,
            ],
        )?;

        connection.execute(
            "INSERT INTO message_sources (
                id,
                message_id,
                source_id,
                account_id,
                folder_id,
                provider_message_id,
                imap_uid,
                flags_json,
                first_seen_at,
                last_seen_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?8)",
            params![
                format!("msrc_{}", Uuid::new_v4()),
                message_id,
                source_id,
                account_id,
                folder_id,
                header.provider_message_id,
                flags_json,
                now,
            ],
        )?;

        inserted_count += 1;
        inserted_message_ids.push(message_id);
    }

    transaction.commit()?;

    Ok(PersistObservedMessagesResult {
        fetched_count: headers.len(),
        inserted_count,
        inserted_message_ids,
    })
}

fn imap_message_thread_key(
    connection: &Connection,
    header: &ImapMessageHeader,
) -> Result<Option<String>> {
    if let Some(root_reference) = header.references.first() {
        return Ok(Some(format!("rfc:{root_reference}")));
    }

    if let Some(parent_id) = header.in_reply_to.as_deref() {
        if let Some(existing_thread_key) =
            existing_thread_key_for_rfc_message_id(connection, parent_id)?
        {
            return Ok(Some(existing_thread_key));
        }
        return Ok(Some(format!("rfc:{parent_id}")));
    }

    if let Some(message_id) = header.message_id.as_deref() {
        return Ok(Some(format!("rfc:{message_id}")));
    }

    let subject = normalize_thread_subject(&header.subject);
    let sender = normalize_thread_address(&header.from_address);
    if subject.is_empty() && sender.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!("subject:{subject}::from:{sender}")))
    }
}

fn existing_thread_key_for_rfc_message_id(
    connection: &Connection,
    rfc_message_id: &str,
) -> Result<Option<String>> {
    connection
        .query_row(
            "SELECT thread_key
             FROM messages
             WHERE rfc_message_id IS NOT NULL
               AND lower(rfc_message_id) = lower(?1)
               AND thread_key IS NOT NULL
               AND trim(thread_key) <> ''
             ORDER BY created_at ASC
             LIMIT 1",
            params![rfc_message_id],
            |row| row.get(0),
        )
        .optional()
}

fn normalize_thread_subject(subject: &str) -> String {
    let mut normalized = subject.trim().to_ascii_lowercase();
    loop {
        let stripped = ["re:", "fwd:", "fw:", "回复:", "答复:", "转发:"]
            .iter()
            .find_map(|prefix| normalized.strip_prefix(prefix).map(str::trim));
        let Some(stripped) = stripped else {
            break;
        };
        normalized = stripped.to_string();
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_thread_address(address: &str) -> String {
    let trimmed = address.trim().to_ascii_lowercase();
    if let (Some(start), Some(end)) = (trimmed.rfind('<'), trimmed.rfind('>')) {
        if start < end {
            return trimmed[start + 1..end].trim().to_string();
        }
    }
    trimmed
}

fn imap_security_flags(header: &ImapMessageHeader) -> String {
    json!({
        "authentication_results": header.authentication_results,
        "received_spf": header.received_spf,
        "dkim_signature": header.dkim_signature,
    })
    .to_string()
}

fn imap_initial_flags(
    connection: &Connection,
    folder_id: &str,
    header: &ImapMessageHeader,
) -> Result<String> {
    // A failed lookup must not be treated as "row absent": that would drop the
    // spam/trash classification and file the message into the inbox instead.
    let folder_kind: Option<String> = connection
        .query_row(
            "SELECT folder_kind FROM mail_folders WHERE id = ?1",
            params![folder_id],
            |row| row.get(0),
        )
        .optional()?;
    let mut flags = serde_json::Map::new();

    if let Some(kind) = folder_kind
        .as_deref()
        .map(str::trim)
        .filter(|kind| matches!(*kind, "spam" | "trash" | "archive"))
    {
        flags.insert(
            "local_folder".to_string(),
            serde_json::Value::String(kind.to_string()),
        );
    }

    if imap_header_is_newsletter(header) {
        flags.insert(
            "labels".to_string(),
            serde_json::Value::Array(vec![serde_json::Value::String("newsletters".to_string())]),
        );
        if let Some(metadata) = imap_newsletter_metadata(header) {
            flags.insert("newsletter".to_string(), metadata);
        }
    }

    Ok(serde_json::Value::Object(flags).to_string())
}
