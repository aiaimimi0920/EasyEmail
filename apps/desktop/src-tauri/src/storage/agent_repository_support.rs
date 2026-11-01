use rusqlite::{params, Connection, OptionalExtension, Result};

use super::agent_models::{AgentMessageRow, AgentServiceRow, AgentThreadRow};

pub(super) fn get_agent_message(
    connection: &Connection,
    id: &str,
) -> Result<Option<AgentMessageRow>> {
    connection
        .query_row(
            "SELECT
                id,
                thread_id,
                message_id,
                direction,
                semantic_role,
                parsed_status,
                parsed_payload_json,
                created_at
             FROM agent_messages
             WHERE id = ?1",
            params![id],
            map_agent_message_row,
        )
        .optional()
}

pub(super) fn agent_service_select_sql(where_clause: &str) -> String {
    format!(
        "SELECT
            id,
            display_name,
            email_address,
            description,
            service_kind,
            trust_level,
            default_sender_account_id,
            status,
            created_at,
            updated_at
         FROM agent_services
         WHERE {where_clause}"
    )
}

pub(super) fn agent_thread_select_sql(where_clause: &str) -> String {
    format!(
        "SELECT
            id,
            agent_service_id,
            sender_account_id,
            subject,
            status,
            last_outgoing_message_id,
            last_incoming_message_id,
            correlation_key,
            created_at,
            updated_at,
            completed_at
         FROM agent_threads
         WHERE {where_clause}"
    )
}

pub(super) fn map_agent_service_row(row: &rusqlite::Row<'_>) -> Result<AgentServiceRow> {
    Ok(AgentServiceRow {
        id: row.get("id")?,
        display_name: row.get("display_name")?,
        email_address: row.get("email_address")?,
        description: row.get("description")?,
        service_kind: row.get("service_kind")?,
        trust_level: row.get("trust_level")?,
        default_sender_account_id: row.get("default_sender_account_id")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(super) fn map_agent_thread_row(row: &rusqlite::Row<'_>) -> Result<AgentThreadRow> {
    Ok(AgentThreadRow {
        id: row.get("id")?,
        agent_service_id: row.get("agent_service_id")?,
        sender_account_id: row.get("sender_account_id")?,
        subject: row.get("subject")?,
        status: row.get("status")?,
        last_outgoing_message_id: row.get("last_outgoing_message_id")?,
        last_incoming_message_id: row.get("last_incoming_message_id")?,
        correlation_key: row.get("correlation_key")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        completed_at: row.get("completed_at")?,
    })
}

pub(super) fn map_agent_message_row(row: &rusqlite::Row<'_>) -> Result<AgentMessageRow> {
    Ok(AgentMessageRow {
        id: row.get("id")?,
        thread_id: row.get("thread_id")?,
        message_id: row.get("message_id")?,
        direction: row.get("direction")?,
        semantic_role: row.get("semantic_role")?,
        parsed_status: row.get("parsed_status")?,
        parsed_payload_json: row.get("parsed_payload_json")?,
        created_at: row.get("created_at")?,
    })
}
