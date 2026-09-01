use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentServiceRow {
    pub id: String,
    pub display_name: String,
    pub email_address: String,
    pub description: Option<String>,
    pub service_kind: String,
    pub trust_level: String,
    pub default_sender_account_id: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewAgentService {
    pub display_name: String,
    pub email_address: String,
    pub description: Option<String>,
    pub service_kind: String,
    pub trust_level: String,
    pub default_sender_account_id: Option<String>,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentThreadRow {
    pub id: String,
    pub agent_service_id: String,
    pub sender_account_id: String,
    pub subject: String,
    pub status: String,
    pub last_outgoing_message_id: Option<String>,
    pub last_incoming_message_id: Option<String>,
    pub correlation_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewAgentThread {
    pub agent_service_id: String,
    pub sender_account_id: String,
    pub subject: String,
    pub correlation_key: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMessageRow {
    pub id: String,
    pub thread_id: String,
    pub message_id: String,
    pub direction: String,
    pub semantic_role: String,
    pub parsed_status: Option<String>,
    pub parsed_payload_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewAgentMessage {
    pub thread_id: String,
    pub message_id: String,
    pub direction: String,
    pub semantic_role: String,
    pub parsed_status: Option<String>,
    pub parsed_payload_json: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentThreadDetail {
    pub thread: AgentThreadRow,
    pub messages: Vec<AgentMessageRow>,
}

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

fn get_agent_message(connection: &Connection, id: &str) -> Result<Option<AgentMessageRow>> {
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

fn agent_service_select_sql(where_clause: &str) -> String {
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

fn agent_thread_select_sql(where_clause: &str) -> String {
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

fn map_agent_service_row(row: &rusqlite::Row<'_>) -> Result<AgentServiceRow> {
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

fn map_agent_thread_row(row: &rusqlite::Row<'_>) -> Result<AgentThreadRow> {
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

fn map_agent_message_row(row: &rusqlite::Row<'_>) -> Result<AgentMessageRow> {
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

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::storage::account_repository::{
        insert_agent_account, list_agent_accounts, list_normal_accounts, NewAgentAccount,
    };
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    use super::*;

    #[test]
    fn agent_account_is_not_listed_in_normal_accounts() {
        let connection = test_connection();

        let account = insert_agent_account(
            &connection,
            NewAgentAccount {
                display_name: "Agent Sender".to_string(),
                email_address: "agent@example.test".to_string(),
                now: "2026-06-12T02:00:00Z".to_string(),
            },
        )
        .expect("insert agent account");
        let normal_accounts = list_normal_accounts(&connection).expect("normal accounts");
        let agent_accounts = list_agent_accounts(&connection).expect("agent accounts");

        assert_eq!(account.scope, "agent");
        assert!(normal_accounts.iter().all(|row| row.id != account.id));
        assert_eq!(agent_accounts.len(), 1);
    }

    #[test]
    fn agent_service_repository_persists_trust_level() {
        let connection = test_connection();
        seed_agent_account(&connection);

        let service = insert_agent_service(
            &connection,
            NewAgentService {
                display_name: "Remote Agent".to_string(),
                email_address: "remote-agent@example.test".to_string(),
                description: Some("Handles research tasks".to_string()),
                service_kind: "email_agent".to_string(),
                trust_level: "restricted".to_string(),
                default_sender_account_id: Some("acct_agent".to_string()),
                now: "2026-06-12T02:00:00Z".to_string(),
            },
        )
        .expect("insert service");

        assert_eq!(service.trust_level, "restricted");
        assert_eq!(list_agent_services(&connection).expect("services").len(), 1);
    }

    #[test]
    fn agent_thread_repository_returns_detail_with_messages() {
        let connection = test_connection();
        seed_agent_service_and_message(&connection);

        let thread = create_agent_thread(
            &connection,
            NewAgentThread {
                agent_service_id: "agsvc_1".to_string(),
                sender_account_id: "acct_agent".to_string(),
                subject: "Research task".to_string(),
                correlation_key: "thread-key-1".to_string(),
                now: "2026-06-12T02:10:00Z".to_string(),
            },
        )
        .expect("create thread");
        insert_agent_message(
            &connection,
            NewAgentMessage {
                thread_id: thread.id.clone(),
                message_id: "msg_outgoing".to_string(),
                direction: "outgoing".to_string(),
                semantic_role: "task_request".to_string(),
                parsed_status: Some("sent".to_string()),
                parsed_payload_json: "{}".to_string(),
                now: "2026-06-12T02:11:00Z".to_string(),
            },
        )
        .expect("insert agent message");

        let detail = get_agent_thread_detail(&connection, &thread.id)
            .expect("detail")
            .expect("thread exists");

        assert_eq!(detail.thread.subject, "Research task");
        assert_eq!(detail.messages.len(), 1);
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    fn seed_agent_service_and_message(connection: &Connection) {
        seed_agent_account(connection);
        connection
            .execute(
                "UPDATE accounts
                 SET status = 'ready',
                     auth_status = 'valid',
                     receive_status = 'enabled',
                     send_status = 'enabled'
                 WHERE id = 'acct_agent'",
                [],
            )
            .expect("mark agent account send enabled");
        connection
            .execute(
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
                ) VALUES ('agsvc_1', 'Remote Agent', 'remote-agent@example.test', 'Handles research tasks', 'email_agent', 'trusted', 'acct_agent', 'active', '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
                [],
            )
            .expect("insert service");
        connection
            .execute(
                "INSERT INTO messages (
                    id,
                    rfc_message_id,
                    subject,
                    from_address,
                    snippet,
                    body_text_cache,
                    body_cache_state,
                    classification,
                    created_at,
                    updated_at
                ) VALUES ('msg_outgoing', '<outgoing@example.test>', 'Research task', 'agent@example.test', 'Please summarize', 'Please summarize', 'cached', 'outgoing', '2026-06-12T02:10:00Z', '2026-06-12T02:10:00Z')",
                [],
            )
            .expect("insert outgoing message");
    }

    fn seed_agent_account(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO accounts (
                    id,
                    scope,
                    kind,
                    display_name,
                    primary_address,
                    provider_label,
                    status,
                    auth_status,
                    receive_status,
                    send_status,
                    listed_in_all_accounts,
                    created_at,
                    updated_at
                ) VALUES ('acct_agent', 'agent', 'agent_owned', 'Agent Sender', 'agent@example.test', 'Manual SMTP', 'configuring', 'missing', 'disabled', 'disabled', 0, '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
                [],
            )
            .expect("insert agent account");
    }
}
