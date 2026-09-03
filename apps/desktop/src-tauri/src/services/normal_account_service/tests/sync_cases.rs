use super::*;

#[test]
fn normal_account_initial_sync_saves_messages() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);

    let sync = sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");

    assert_eq!(sync.inserted_count, 1);
    assert_eq!(
        list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .len(),
        1
    );
}

#[test]
fn normal_account_sync_extracts_codes_for_inserted_messages() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![ImapMessageHeader {
        provider_message_id: "uid-otp-1".to_string(),
        message_id: Some("otp-1@example.test".to_string()),
        in_reply_to: None,
        references: Vec::new(),
        subject: "OpenAI sign in".to_string(),
        from_address: "noreply@openai.com".to_string(),
        date_received: "2026-06-12T00:05:00Z".to_string(),
        snippet: "Your verification code is 996703".to_string(),
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
    }]);
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);

    let sync = sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");

    assert_eq!(sync.inserted_count, 1);

    let message = list_normal_account_messages(&connection, &result.account.id)
        .expect("messages")
        .pop()
        .expect("message");
    let rows = list_recent_verification_codes(
        &connection,
        RecentVerificationCodeFilter {
            temp_mailbox_id: None,
            limit: 10,
        },
    )
    .expect("list codes");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].message_id, message.message_id);
    assert_eq!(rows[0].code, "996703");
}

#[test]
fn normal_account_sync_imports_remote_spam_folder_messages_as_spam() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_connection_success()
        .with_folders(test_remote_folders())
        .with_recent_headers_by_folder(vec![
            ("INBOX", vec![fake_header("uid-inbox", "Welcome")]),
            ("Spam", vec![fake_header("uid-spam", "Suspicious offer")]),
        ]);
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);

    let sync = sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");

    let messages = list_normal_account_messages(&connection, &result.account.id).expect("messages");
    assert_eq!(sync.inserted_count, 2);
    assert_eq!(messages.len(), 2);
    assert!(messages.iter().any(|message| {
        message.subject == "Welcome" && message.local_state.local_folder == "inbox"
    }));
    assert!(messages.iter().any(|message| {
        message.subject == "Suspicious offer" && message.local_state.local_folder == "spam"
    }));
}

#[test]
fn normal_account_sync_discovers_spam_folder_after_inbox_was_already_stored() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let initial_adapter =
        FakeImapAdapter::with_recent_headers(vec![fake_header("uid-inbox", "Welcome")]);
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &initial_adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &initial_adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("initial sync");

    let later_adapter = FakeImapAdapter::with_connection_success()
        .with_folders(test_remote_folders())
        .with_recent_headers_by_folder(vec![
            ("INBOX", vec![fake_header("uid-inbox", "Welcome")]),
            ("Spam", vec![fake_header("uid-spam", "Suspicious offer")]),
        ]);
    let sync = sync_recent_headers(
        &connection,
        &vault,
        &later_adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("later sync");

    let messages = list_normal_account_messages(&connection, &result.account.id).expect("messages");
    assert_eq!(sync.inserted_count, 1);
    assert!(messages.iter().any(|message| {
        message.subject == "Suspicious offer" && message.local_state.local_folder == "spam"
    }));
}
