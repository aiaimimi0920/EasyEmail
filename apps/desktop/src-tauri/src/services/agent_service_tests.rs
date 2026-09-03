use rusqlite::Connection;

use crate::storage::db::open_in_memory_database;
use crate::storage::migrations::run_migrations;

use super::*;

#[test]
fn agent_task_requires_agent_scope_sender() {
    let connection = test_connection();
    seed_normal_sender_and_agent_service(&connection, "trusted");

    let error = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_normal".to_string(),
            subject: "Research task".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect_err("normal sender blocked");

    assert_eq!(error.code, "agent_sender_scope_required");
}

#[test]
fn blocked_agent_service_rejects_send() {
    let connection = test_connection();
    seed_agent_sender_and_service(&connection, "blocked");

    let error = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect_err("blocked service rejected");

    assert_eq!(error.code, "agent_service_blocked");
}

#[test]
fn restricted_agent_service_requires_confirmation() {
    let connection = test_connection();
    seed_agent_sender_and_service(&connection, "restricted");

    let error = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect_err("confirmation required");

    assert_eq!(error.code, "agent_service_restricted_confirmation_required");
}

#[test]
fn trusted_agent_task_send_creates_thread_message_and_queue() {
    let connection = test_connection();
    seed_agent_sender_and_service(&connection, "trusted");

    let result = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect("send task");

    assert_eq!(result.thread.status, "awaiting_reply");
    assert_eq!(result.queue.status, "queued");
    assert_eq!(result.agent_message.direction, "outgoing");
}

#[test]
fn agent_task_rolls_back_all_records_when_queue_insert_fails() {
    let connection = test_connection();
    seed_agent_sender_and_service(&connection, "trusted");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_agent_send_queue_insert
             BEFORE INSERT ON send_queue
             BEGIN
               SELECT RAISE(ABORT, 'forced agent queue failure');
             END;",
        )
        .expect("install failure trigger");

    let error = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Must roll back".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect_err("queue insert should fail");

    for table in ["messages", "agent_threads", "agent_messages", "send_queue"] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rolled back rows");
        assert_eq!(count, 0, "{table} should remain empty");
    }
    assert_eq!(error.code, "sqlite_agent_failed");
}

#[test]
fn incoming_reply_links_by_in_reply_to() {
    let connection = test_connection();
    seed_agent_thread_with_outgoing_message(&connection);
    seed_incoming_agent_reply(&connection, "msg_reply", "remote-agent@example.test");

    let result = associate_incoming_agent_reply(
        &connection,
        AgentReplyAssociationRequest {
            message_id: "msg_reply".to_string(),
            from_address: "remote-agent@example.test".to_string(),
            in_reply_to_message_id: Some("<outgoing@example.test>".to_string()),
            references: Vec::new(),
        },
        "2026-06-12T02:30:00Z".to_string(),
    )
    .expect("associate reply");

    assert_eq!(result.status, "linked");
    assert_eq!(result.thread.status, "in_progress");
    assert_eq!(result.agent_message.direction, "incoming");
}

#[test]
fn incoming_reply_does_not_link_thread_owned_by_another_agent_service() {
    let connection = test_connection();
    seed_agent_thread_with_outgoing_message(&connection);
    connection
        .execute(
            "INSERT INTO agent_services (
                id, display_name, email_address, description, service_kind, trust_level,
                default_sender_account_id, status, created_at, updated_at
             ) VALUES (
                'agsvc_2', 'Other Agent', 'other-agent@example.test', 'Other service',
                'email_agent', 'trusted', 'acct_agent', 'active',
                '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z'
             )",
            [],
        )
        .expect("insert other service");
    seed_incoming_agent_reply(&connection, "msg_other_reply", "other-agent@example.test");

    let result = associate_incoming_agent_reply(
        &connection,
        AgentReplyAssociationRequest {
            message_id: "msg_other_reply".to_string(),
            from_address: "other-agent@example.test".to_string(),
            in_reply_to_message_id: Some("<outgoing@example.test>".to_string()),
            references: Vec::new(),
        },
        "2026-06-12T02:30:00Z".to_string(),
    )
    .expect("associate other service reply");

    assert_eq!(result.status, "needs_attention");
    assert_eq!(result.thread.agent_service_id, "agsvc_2");
    assert_ne!(result.thread.id, "agthread_1");
}

#[test]
fn unmatched_agent_reply_goes_to_needs_attention() {
    let connection = test_connection();
    seed_agent_service_only(&connection);
    seed_incoming_agent_reply(&connection, "msg_unmatched", "remote-agent@example.test");

    let result = associate_incoming_agent_reply(
        &connection,
        AgentReplyAssociationRequest {
            message_id: "msg_unmatched".to_string(),
            from_address: "remote-agent@example.test".to_string(),
            in_reply_to_message_id: None,
            references: Vec::new(),
        },
        "2026-06-12T02:35:00Z".to_string(),
    )
    .expect("associate unmatched");

    assert_eq!(result.status, "needs_attention");
    assert_eq!(result.thread.status, "needs_attention");
    assert_eq!(result.agent_message.direction, "incoming");
}

fn test_connection() -> Connection {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");
    connection
}

fn seed_normal_sender_and_agent_service(connection: &Connection, trust_level: &str) {
    seed_sender(connection, "acct_normal", "normal", "normal_long_lived", 1);
    seed_agent_service(connection, trust_level, Some("acct_normal"));
}

fn seed_agent_sender_and_service(connection: &Connection, trust_level: &str) {
    seed_sender(connection, "acct_agent", "agent", "agent_owned", 0);
    seed_smtp_source(connection, "acct_agent");
    seed_agent_service(connection, trust_level, Some("acct_agent"));
}

fn seed_sender(connection: &Connection, account_id: &str, scope: &str, kind: &str, listed: i64) {
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
            ) VALUES (?1, ?2, ?3, 'Sender', 'sender@example.test', 'Manual SMTP', 'ready', 'valid', 'enabled', 'enabled', ?4, '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
            rusqlite::params![account_id, scope, kind, listed],
        )
        .expect("insert sender");
}

fn seed_smtp_source(connection: &Connection, account_id: &str) {
    connection
        .execute(
            "INSERT INTO mailbox_sources (
                id,
                account_id,
                source_kind,
                address,
                provider_id,
                config_json,
                credential_ref_id,
                status,
                created_at,
                updated_at
            ) VALUES ('src_smtp', ?1, 'smtp', 'sender@example.test', 'smtp.example.test', '{\"host\":\"smtp.example.test\",\"port\":587,\"security\":\"starttls\",\"username\":\"sender@example.test\"}', 'cred_smtp', 'ready', '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
            rusqlite::params![account_id],
        )
        .expect("insert smtp source");
    connection
        .execute(
            "INSERT INTO credential_refs (
                id,
                owner_account_id,
                source_id,
                secret_backend,
                secret_key,
                credential_kind,
                auth_method,
                status,
                created_at,
                updated_at
            ) VALUES ('cred_smtp', ?1, 'src_smtp', 'fake_vault', 'secret://smtp/acct_agent', 'smtp_password', 'password', 'active', '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
            rusqlite::params![account_id],
        )
        .expect("insert credential");
}

fn seed_agent_service(
    connection: &Connection,
    trust_level: &str,
    default_sender_account_id: Option<&str>,
) {
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
            ) VALUES ('agsvc_1', 'Remote Agent', 'remote-agent@example.test', 'Handles research tasks', 'email_agent', ?1, ?2, 'active', '2026-06-12T02:00:00Z', '2026-06-12T02:00:00Z')",
            rusqlite::params![trust_level, default_sender_account_id],
        )
        .expect("insert service");
}

fn seed_agent_service_only(connection: &Connection) {
    seed_sender(connection, "acct_agent", "agent", "agent_owned", 0);
    seed_agent_service(connection, "trusted", Some("acct_agent"));
}

fn seed_agent_thread_with_outgoing_message(connection: &Connection) {
    seed_agent_service_only(connection);
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
            ) VALUES ('msg_outgoing', '<outgoing@example.test>', 'Research task', 'agent@example.test', 'Please summarize', 'Please summarize', 'cached', 'outgoing', '2026-06-12T02:20:00Z', '2026-06-12T02:20:00Z')",
            [],
        )
        .expect("insert outgoing");
    connection
        .execute(
            "INSERT INTO agent_threads (
                id,
                agent_service_id,
                sender_account_id,
                subject,
                status,
                last_outgoing_message_id,
                correlation_key,
                created_at,
                updated_at
            ) VALUES ('agthread_1', 'agsvc_1', 'acct_agent', 'Research task', 'awaiting_reply', 'msg_outgoing', 'corr_1', '2026-06-12T02:20:00Z', '2026-06-12T02:20:00Z')",
            [],
        )
        .expect("insert thread");
    connection
        .execute(
            "INSERT INTO agent_messages (
                id,
                thread_id,
                message_id,
                direction,
                semantic_role,
                parsed_status,
                parsed_payload_json,
                created_at
            ) VALUES ('agmsg_out', 'agthread_1', 'msg_outgoing', 'outgoing', 'task_request', 'queued', '{}', '2026-06-12T02:20:00Z')",
            [],
        )
        .expect("insert agent outgoing");
}

fn seed_incoming_agent_reply(connection: &Connection, message_id: &str, from_address: &str) {
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
            ) VALUES (?1, ?2, 'Re: Research task', ?3, 'Reply body', 'Reply body', 'cached', 'normal', '2026-06-12T02:30:00Z', '2026-06-12T02:30:00Z')",
            rusqlite::params![message_id, format!("<{message_id}@example.test>"), from_address],
        )
        .expect("insert incoming reply");
}
