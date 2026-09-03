use super::*;
use crate::domain::message::Message;
use crate::domain::temp_mailbox::TempMailbox;
use crate::storage::db::open_in_memory_database;
use crate::storage::migrations::run_migrations;
use crate::storage::temp_mailbox_repository::insert_temp_mailbox;

mod draft_cases;
mod imap_ingest_cases;
mod local_state_cases;
mod newsletter_cases;
mod query_and_sending_cases;
mod temp_ingest_cases;

fn observed_message(id: &str, session_id: &str) -> EasyEmailObservedMessage {
    EasyEmailObservedMessage {
        id: id.to_string(),
        session_id: session_id.to_string(),
        provider_instance_id: "provider_instance_1".to_string(),
        observed_at: "2026-06-12T00:10:00Z".to_string(),
        sender: Some("noreply@example.test".to_string()),
        subject: Some("Your code is 123456".to_string()),
        text_body: Some("Use 123456 to continue.".to_string()),
        html_body: None,
        raw_json: serde_json::json!({"id": id, "sessionId": session_id}),
    }
}

fn seed_imap_identity(connection: &Connection) -> (String, String, String) {
    let account_id = "acct_imap".to_string();
    let source_id = "src_imap".to_string();
    let folder_id = "folder_inbox".to_string();

    connection
        .execute(
            "INSERT INTO accounts (
                id, scope, kind, display_name, primary_address, provider_label, status,
                auth_status, receive_status, send_status, listed_in_all_accounts,
                created_at, updated_at
            ) VALUES (
                ?1, 'normal', 'normal_long_lived', 'QQ Mail', 'user@qq.com',
                'Manual IMAP', 'ready', 'valid', 'enabled', 'enabled', 1, ?2, ?2
            )",
            params![account_id, "2026-06-12T00:00:00Z"],
        )
        .expect("insert imap account");
    connection
        .execute(
            "INSERT INTO mailbox_sources (
                id, account_id, source_kind, address, provider_id, config_json, status,
                created_at, updated_at
            ) VALUES (
                ?1, ?2, 'imap', 'user@qq.com', 'imap.qq.com', '{}', 'ready', ?3, ?3
            )",
            params![source_id, account_id, "2026-06-12T00:00:00Z"],
        )
        .expect("insert imap source");
    connection
        .execute(
            "INSERT INTO mail_folders (
                id, account_id, source_id, provider_folder_id, display_name, path,
                delimiter, folder_kind, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, 'INBOX', 'INBOX', 'INBOX', '/', 'inbox', ?4, ?4
            )",
            params![folder_id, account_id, source_id, "2026-06-12T00:00:00Z"],
        )
        .expect("insert imap folder");

    (account_id, source_id, folder_id)
}

fn seed_imap_folder(
    connection: &Connection,
    account_id: &str,
    source_id: &str,
    display_name: &str,
    folder_kind: &str,
) -> String {
    let folder_id = format!("folder_{}", folder_kind);
    connection
        .execute(
            "INSERT INTO mail_folders (
                id, account_id, source_id, provider_folder_id, display_name, path,
                delimiter, folder_kind, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?4, ?4, '/', ?5, ?6, ?6
            )",
            params![
                folder_id,
                account_id,
                source_id,
                display_name,
                folder_kind,
                "2026-06-12T00:00:00Z"
            ],
        )
        .expect("insert imap folder");
    folder_id
}

fn seed_smtp_source(connection: &Connection, account_id: &str) {
    connection
        .execute(
            "INSERT INTO mailbox_sources (
                id, account_id, source_kind, address, provider_id, config_json, status,
                created_at, updated_at
            ) VALUES (
                'src_smtp', ?1, 'smtp', 'user@qq.com', 'smtp.qq.com', '{}', 'ready', ?2, ?2
            )",
            params![account_id, "2026-06-12T00:00:00Z"],
        )
        .expect("insert smtp source");
}

fn imap_header(uid: &str, subject: &str, from_address: &str) -> ImapMessageHeader {
    imap_header_with_date(uid, subject, from_address, "2026-06-12T00:10:00Z")
}

fn imap_header_with_date(
    uid: &str,
    subject: &str,
    from_address: &str,
    date_received: &str,
) -> ImapMessageHeader {
    ImapMessageHeader {
        provider_message_id: uid.to_string(),
        message_id: Some(format!("{uid}@example.test")),
        in_reply_to: None,
        references: Vec::new(),
        subject: subject.to_string(),
        from_address: from_address.to_string(),
        date_received: date_received.to_string(),
        snippet: format!("{from_address} / {subject}"),
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
