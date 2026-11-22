use rusqlite::{params, Connection, Result};
use uuid::Uuid;

use super::agent_models::{AgentMessageRow, AgentThreadDetail, NewAgentMessage};
use super::agent_repository_support::{get_agent_message, map_agent_message_row};
use super::agent_thread_repository::get_agent_thread;

pub fn insert_agent_message(
    connection: &Connection,
    message: NewAgentMessage,
) -> Result<AgentMessageRow> {
    let id = format!("agmsg_{}", Uuid::new_v4());
    connection.execute(
        "INSERT INTO agent_messages (
            id,
            thread_id,
            message_id,
            direction,
            semantic_role,
            parsed_status,
            parsed_payload_json,
            created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            message.thread_id,
            message.message_id,
            message.direction,
            message.semantic_role,
            message.parsed_status,
            message.parsed_payload_json,
            message.now,
        ],
    )?;
    get_agent_message(connection, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_agent_thread_detail(
    connection: &Connection,
    thread_id: &str,
) -> Result<Option<AgentThreadDetail>> {
    let Some(thread) = get_agent_thread(connection, thread_id)? else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
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
         WHERE thread_id = ?1
         ORDER BY created_at ASC, id ASC",
    )?;
    let messages = statement
        .query_map(params![thread_id], map_agent_message_row)?
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(AgentThreadDetail { thread, messages }))
}
