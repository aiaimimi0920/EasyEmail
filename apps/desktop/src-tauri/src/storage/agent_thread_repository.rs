use rusqlite::{params, Connection, OptionalExtension, Result};
use uuid::Uuid;

use super::agent_models::{AgentThreadRow, NewAgentThread};
use super::agent_repository_support::{agent_thread_select_sql, map_agent_thread_row};

pub fn create_agent_thread(
    connection: &Connection,
    thread: NewAgentThread,
) -> Result<AgentThreadRow> {
    let id = format!("agthread_{}", Uuid::new_v4());
    connection.execute(
        "INSERT INTO agent_threads (
            id,
            agent_service_id,
            sender_account_id,
            subject,
            status,
            correlation_key,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?6)",
        params![
            id,
            thread.agent_service_id,
            thread.sender_account_id,
            thread.subject,
            thread.correlation_key,
            thread.now,
        ],
    )?;
    get_agent_thread(connection, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_agent_thread(connection: &Connection, id: &str) -> Result<Option<AgentThreadRow>> {
    connection
        .query_row(
            agent_thread_select_sql("id = ?1").as_str(),
            params![id],
            map_agent_thread_row,
        )
        .optional()
}

pub fn list_agent_threads(connection: &Connection) -> Result<Vec<AgentThreadRow>> {
    let mut statement = connection.prepare(
        format!(
            "{} ORDER BY updated_at DESC, id DESC",
            agent_thread_select_sql("1 = 1")
        )
        .as_str(),
    )?;
    let rows = statement.query_map([], map_agent_thread_row)?;
    rows.collect()
}

pub fn find_agent_thread_by_outgoing_rfc_message_id(
    connection: &Connection,
    agent_service_id: &str,
    rfc_message_id: &str,
) -> Result<Option<AgentThreadRow>> {
    let rfc_message_id = rfc_message_id.trim();
    if rfc_message_id.is_empty() {
        return Ok(None);
    }

    connection
        .query_row(
            "SELECT
                agent_threads.id,
                agent_threads.agent_service_id,
                agent_threads.sender_account_id,
                agent_threads.subject,
                agent_threads.status,
                agent_threads.last_outgoing_message_id,
                agent_threads.last_incoming_message_id,
                agent_threads.correlation_key,
                agent_threads.created_at,
                agent_threads.updated_at,
                agent_threads.completed_at
             FROM agent_threads
             INNER JOIN agent_messages ON agent_messages.thread_id = agent_threads.id
             INNER JOIN messages ON messages.id = agent_messages.message_id
             WHERE agent_messages.direction = 'outgoing'
               AND agent_threads.agent_service_id = ?1
               AND messages.rfc_message_id IS NOT NULL
               AND lower(messages.rfc_message_id) = lower(?2)
             ORDER BY agent_messages.created_at DESC, agent_threads.updated_at DESC
             LIMIT 1",
            params![agent_service_id, rfc_message_id],
            map_agent_thread_row,
        )
        .optional()
}

pub fn update_agent_thread_after_outgoing(
    connection: &Connection,
    thread_id: &str,
    message_id: &str,
    status: &str,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE agent_threads
         SET status = ?1,
             last_outgoing_message_id = ?2,
             updated_at = ?3
         WHERE id = ?4",
        params![status, message_id, now, thread_id],
    )?;
    Ok(())
}

pub fn update_agent_thread_after_incoming(
    connection: &Connection,
    thread_id: &str,
    message_id: &str,
    status: &str,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE agent_threads
         SET status = ?1,
             last_incoming_message_id = ?2,
             updated_at = ?3
         WHERE id = ?4",
        params![status, message_id, now, thread_id],
    )?;
    Ok(())
}
