use rusqlite::{params, Connection};

use super::account_repository::{
    insert_agent_account, list_agent_accounts, list_normal_accounts, NewAgentAccount,
};
use super::agent_repository::*;
use super::db::open_in_memory_database;
use super::migrations::run_migrations;

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
fn agent_service_lookup_normalizes_email_and_ignores_deleted_rows() {
    let connection = test_connection();
    seed_agent_account(&connection);

    let service = insert_agent_service(
        &connection,
        NewAgentService {
            display_name: "Remote Agent".to_string(),
            email_address: "Remote-Agent@Example.Test".to_string(),
            description: None,
            service_kind: "email_agent".to_string(),
            trust_level: "trusted".to_string(),
            default_sender_account_id: Some("acct_agent".to_string()),
            now: "2026-06-12T02:00:00Z".to_string(),
        },
    )
    .expect("insert service");

    assert_eq!(service.email_address, "remote-agent@example.test");
    assert_eq!(
        get_agent_service_by_email(&connection, "REMOTE-AGENT@EXAMPLE.TEST")
            .expect("lookup service")
            .expect("service exists")
            .id,
        service.id
    );

    connection
        .execute(
            "UPDATE agent_services SET deleted_at = ?1 WHERE id = ?2",
            params!["2026-06-12T03:00:00Z", service.id],
        )
        .expect("soft delete service");

    assert!(
        get_agent_service_by_email(&connection, "remote-agent@example.test")
            .expect("lookup deleted service")
            .is_none()
    );
    assert!(list_agent_services(&connection)
        .expect("list active services")
        .is_empty());
}

#[test]
fn outgoing_rfc_lookup_ignores_empty_values_and_matches_case_insensitively() {
    let connection = test_connection();
    seed_agent_service_and_message(&connection);
    let thread = create_agent_thread(
        &connection,
        NewAgentThread {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            correlation_key: "thread-key-rfc".to_string(),
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

    assert!(
        find_agent_thread_by_outgoing_rfc_message_id(&connection, "agsvc_1", "  ")
            .expect("empty lookup")
            .is_none()
    );
    assert_eq!(
        find_agent_thread_by_outgoing_rfc_message_id(
            &connection,
            "agsvc_1",
            " <OUTGOING@EXAMPLE.TEST> ",
        )
        .expect("case-insensitive lookup")
        .expect("thread exists")
        .id,
        thread.id
    );
}

#[test]
fn agent_message_uniqueness_and_thread_updates_are_preserved() {
    let connection = test_connection();
    seed_agent_service_and_message(&connection);
    let thread = create_agent_thread(
        &connection,
        NewAgentThread {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            correlation_key: "thread-key-update".to_string(),
            now: "2026-06-12T02:10:00Z".to_string(),
        },
    )
    .expect("create thread");
    let message = NewAgentMessage {
        thread_id: thread.id.clone(),
        message_id: "msg_outgoing".to_string(),
        direction: "outgoing".to_string(),
        semantic_role: "task_request".to_string(),
        parsed_status: Some("sent".to_string()),
        parsed_payload_json: "{}".to_string(),
        now: "2026-06-12T02:11:00Z".to_string(),
    };
    insert_agent_message(&connection, message.clone()).expect("insert agent message");
    assert!(insert_agent_message(&connection, message).is_err());

    update_agent_thread_after_outgoing(
        &connection,
        &thread.id,
        "msg_outgoing",
        "awaiting_reply",
        "2026-06-12T02:12:00Z",
    )
    .expect("update outgoing state");
    let updated = get_agent_thread(&connection, &thread.id)
        .expect("get updated thread")
        .expect("thread exists");
    assert_eq!(updated.status, "awaiting_reply");
    assert_eq!(
        updated.last_outgoing_message_id.as_deref(),
        Some("msg_outgoing")
    );
    assert_eq!(updated.updated_at, "2026-06-12T02:12:00Z");
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
