use rusqlite::{params, Connection, OptionalExtension, Result};
use uuid::Uuid;

use super::agent_models::{AgentServiceRow, NewAgentService};
use super::agent_repository_support::{agent_service_select_sql, map_agent_service_row};

pub fn insert_agent_service(
    connection: &Connection,
    service: NewAgentService,
) -> Result<AgentServiceRow> {
    let id = format!("agsvc_{}", Uuid::new_v4());
    connection.execute(
        "INSERT INTO agent_services (
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
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8)",
        params![
            id,
            service.display_name,
            service.email_address.to_ascii_lowercase(),
            service.description,
            service.service_kind,
            service.trust_level,
            service.default_sender_account_id,
            service.now,
        ],
    )?;
    get_agent_service(connection, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_agent_service(connection: &Connection, id: &str) -> Result<Option<AgentServiceRow>> {
    connection
        .query_row(
            agent_service_select_sql("id = ?1").as_str(),
            params![id],
            map_agent_service_row,
        )
        .optional()
}

pub fn get_agent_service_by_email(
    connection: &Connection,
    email_address: &str,
) -> Result<Option<AgentServiceRow>> {
    connection
        .query_row(
            agent_service_select_sql("email_address = ?1 AND deleted_at IS NULL").as_str(),
            params![email_address.to_ascii_lowercase()],
            map_agent_service_row,
        )
        .optional()
}

pub fn list_agent_services(connection: &Connection) -> Result<Vec<AgentServiceRow>> {
    let mut statement = connection.prepare(
        format!(
            "{} AND deleted_at IS NULL ORDER BY created_at ASC, id ASC",
            agent_service_select_sql("1 = 1")
        )
        .as_str(),
    )?;
    let rows = statement.query_map([], map_agent_service_row)?;
    rows.collect()
}
