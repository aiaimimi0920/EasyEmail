use rusqlite::{params, Connection};

use super::account_repository::*;
use super::db::open_in_memory_database;
use super::migrations::run_migrations;
use crate::domain::account::Account;

fn test_connection() -> Connection {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");
    connection
}

#[test]
fn ensure_anonymous_virtual_account_is_idempotent() {
    let connection = test_connection();
    let first = ensure_anonymous_virtual_account(&connection, "2026-06-11T00:00:00Z".to_string())
        .expect("first ensure");
    let second = ensure_anonymous_virtual_account(&connection, "2026-06-11T00:01:00Z".to_string())
        .expect("second ensure");
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM accounts WHERE kind = 'anonymous_virtual'",
            [],
            |row| row.get(0),
        )
        .expect("count anonymous accounts");
    assert_eq!(first, "acct_anonymous_virtual");
    assert_eq!(first, second);
    assert_eq!(count, 1);
}

#[test]
fn normal_account_query_excludes_agent_accounts() {
    let connection = test_connection();
    ensure_anonymous_virtual_account(&connection, "2026-06-11T00:00:00Z".to_string())
        .expect("ensure anonymous");
    let agent = Account::agent_owned(
        "Agent Sender".to_string(),
        "agent@example.test".to_string(),
        "2026-06-11T00:00:00Z".to_string(),
    );
    insert_account(&connection, &agent).expect("insert agent account");
    let rows = list_normal_accounts(&connection).expect("list normal accounts");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "acct_anonymous_virtual");
    assert_eq!(rows[0].kind, "anonymous_virtual");
}

#[test]
fn account_queries_ignore_soft_deleted_rows() {
    let connection = test_connection();
    let account = Account::agent_owned(
        "Deleted Agent".to_string(),
        "deleted@example.test".to_string(),
        "2026-06-11T00:00:00Z".to_string(),
    );
    let account_id = account.id.clone();
    insert_account(&connection, &account).expect("insert account");
    connection
        .execute(
            "UPDATE accounts SET deleted_at = ?1 WHERE id = ?2",
            params!["2026-06-11T01:00:00Z", account_id],
        )
        .expect("soft delete account");
    assert!(get_account(&connection, &account_id)
        .expect("get deleted account")
        .is_none());
    assert!(list_agent_accounts(&connection)
        .expect("list agent accounts")
        .is_empty());
}

#[test]
fn imap_source_round_trips_config_and_credential_reference() {
    let connection = test_connection();
    let (account, source_id) = insert_normal_imap_account(
        &connection,
        NewNormalImapAccount {
            display_name: "Work".to_string(),
            email_address: "work@example.test".to_string(),
            imap_host: "imap.example.test".to_string(),
            imap_port: 993,
            imap_security: "tls".to_string(),
            imap_username: "work@example.test".to_string(),
            now: "2026-06-11T00:00:00Z".to_string(),
        },
    )
    .expect("insert normal IMAP account");
    connection
        .execute(
            "INSERT INTO credential_refs (
                id, owner_account_id, source_id, secret_backend, secret_key,
                credential_kind, auth_method, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'test', 'ref:v1:work', 'imap_password',
                       'password', 'active', ?4, ?4)",
            params!["cred_work", account.id, source_id, "2026-06-11T00:00:00Z"],
        )
        .expect("insert credential reference");
    update_mailbox_source_credential_ref(
        &connection,
        &source_id,
        "cred_work",
        "2026-06-11T00:01:00Z",
    )
    .expect("bind credential reference");
    let source = get_normal_imap_source_for_account(&connection, &account.id)
        .expect("query IMAP source")
        .expect("IMAP source exists");
    assert_eq!(source.source_id, source_id);
    assert_eq!(source.credential_ref_id, "cred_work");
    assert_eq!(source.secret_key, "ref:v1:work");
    assert_eq!(source.config.host, "imap.example.test");
    assert_eq!(source.config.port, 993);
    assert_eq!(source.config.security, "tls");
    assert_eq!(source.config.username, "work@example.test");
}
