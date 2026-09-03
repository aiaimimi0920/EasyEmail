use super::*;

pub fn insert_message(connection: &Connection, message: &Message) -> Result<()> {
    connection.execute(
        "INSERT INTO messages (
            id,
            rfc_message_id,
            subject,
            from_address,
            snippet,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            message.id,
            message.rfc_message_id,
            message.subject,
            message.from_address,
            message.snippet,
            message.created_at,
            message.updated_at,
        ],
    )?;

    Ok(())
}

pub fn insert_message_source(connection: &Connection, source: &MessageSource) -> Result<()> {
    connection.execute(
        "INSERT INTO message_sources (
            id,
            message_id,
            source_id,
            account_id,
            temp_mailbox_id,
            provider_message_id,
            received_address,
            first_seen_at,
            last_seen_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            source.id,
            source.message_id,
            source.source_id,
            source.account_id,
            source.temp_mailbox_id,
            source.provider_message_id,
            source.received_address,
            source.first_seen_at,
            source.last_seen_at,
        ],
    )?;

    Ok(())
}

pub fn create_temp_message_source(
    message_id: String,
    source_id: String,
    temp_mailbox_id: String,
    provider_message_id: String,
    received_address: String,
    now: String,
) -> MessageSource {
    MessageSource {
        id: format!("msrc_{}", Uuid::new_v4()),
        message_id,
        source_id,
        account_id: None,
        temp_mailbox_id: Some(temp_mailbox_id),
        provider_message_id: Some(provider_message_id),
        received_address: Some(received_address),
        first_seen_at: now.clone(),
        last_seen_at: now,
    }
}
