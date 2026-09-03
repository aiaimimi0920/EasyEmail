use rusqlite::Connection;

use crate::imap::fake::{FakeImapAction, FakeImapAdapter};
use crate::imap::models::{ImapFolder, ImapMessageBody, ImapMessageHeader};
use crate::secret::fake::FakeSecretVaultAdapter;
use crate::secret::SecretVaultAdapter;
use crate::smtp::fake::FakeSmtpAdapter;
use crate::storage::account_repository::get_smtp_source_for_account;
use crate::storage::db::open_in_memory_database;
use crate::storage::message_repository::{
    list_normal_account_messages, list_normal_account_messages_with_options,
    update_message_body_text_cache,
};
use crate::storage::migrations::run_migrations;
use crate::storage::verification_repository::{
    list_recent_verification_codes, RecentVerificationCodeFilter,
};

use super::*;

mod account_cases;
mod detail_cases;
mod flag_cases;
mod move_behavior_cases;
mod move_plan_cases;
mod move_remote_state_cases;
mod sync_cases;

#[cfg(test)]
fn assert_no_sqlite_value_contains(connection: &Connection, needle: &str) {
    use rusqlite::types::ValueRef;

    let table_names = {
        let mut statement = connection
            .prepare(
                "SELECT name
                 FROM sqlite_master
                 WHERE type = 'table'
                   AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .expect("prepare table list");
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query table list")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect table list")
    };

    for table_name in table_names {
        let sql = format!("SELECT * FROM {table_name}");
        let mut statement = connection.prepare(&sql).expect("prepare table scan");
        let column_count = statement.column_count();
        let mut rows = statement.query([]).expect("query table scan");
        while let Some(row) = rows.next().expect("next table row") {
            for index in 0..column_count {
                if let ValueRef::Text(value) = row.get_ref(index).expect("read sqlite value") {
                    let value = std::str::from_utf8(value).expect("sqlite text is utf8");
                    assert!(
                        !value.contains(needle),
                        "SQLite table {table_name} column {index} leaked secret value"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
fn assert_no_normal_account_created(connection: &Connection) {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*)
             FROM accounts
             WHERE scope = 'normal'
               AND kind = 'normal_long_lived'",
            [],
            |row| row.get(0),
        )
        .expect("count normal accounts");

    assert_eq!(count, 0);
}

fn seed_manual_account(
    connection: &Connection,
    vault: &FakeSecretVaultAdapter,
    imap_adapter: &FakeImapAdapter,
    smtp_adapter: &FakeSmtpAdapter,
) -> AddManualImapAccountResult {
    add_manual_imap_account(
        connection,
        vault,
        imap_adapter,
        smtp_adapter,
        manual_request(),
        "2026-06-12T00:00:00Z".to_string(),
    )
    .expect("seed manual imap")
}

fn manual_request() -> ManualImapAccountRequest {
    ManualImapAccountRequest {
        display_name: "Work".to_string(),
        email_address: "work@example.test".to_string(),
        imap_host: "imap.example.test".to_string(),
        imap_port: 993,
        imap_security: "tls".to_string(),
        imap_username: "work@example.test".to_string(),
        imap_password: "app-password".to_string(),
        smtp_host: "smtp.example.test".to_string(),
        smtp_port: 465,
        smtp_security: "tls".to_string(),
        smtp_username: "work@example.test".to_string(),
        smtp_password: "app-password".to_string(),
    }
}

fn fake_header(uid: &str, subject: &str) -> ImapMessageHeader {
    ImapMessageHeader {
        provider_message_id: uid.to_string(),
        message_id: Some(format!("{uid}@example.test")),
        in_reply_to: None,
        references: Vec::new(),
        subject: subject.to_string(),
        from_address: "noreply@example.test".to_string(),
        date_received: "2026-06-12T00:05:00Z".to_string(),
        snippet: format!("{subject} snippet"),
        authentication_results: None,
        received_spf: None,
        dkim_signature: None,
        list_id: None,
        list_unsubscribe: None,
        list_unsubscribe_post: None,
        precedence: None,
        list_post: None,
        list_help: None,
        feedback_id: None,
    }
}

fn test_remote_folders() -> Vec<ImapFolder> {
    vec![
        test_folder("INBOX", "INBOX", "inbox"),
        test_folder("Archive", "Archive", "archive"),
        test_folder("Spam", "Spam", "spam"),
        test_folder("Trash", "Trash", "trash"),
    ]
}

fn test_folder(path: &str, display_name: &str, kind: &str) -> ImapFolder {
    ImapFolder {
        provider_folder_id: path.to_string(),
        display_name: display_name.to_string(),
        path: path.to_string(),
        delimiter: "/".to_string(),
        folder_kind: kind.to_string(),
    }
}

fn test_connection() -> Connection {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");
    connection
}
