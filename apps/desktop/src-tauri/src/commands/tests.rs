use crate::services::easyemail_service::TempRefreshResult;
use crate::services::verification_service::VerificationPollResult;
use crate::storage::account_repository::AccountRow;
use crate::storage::agent_repository::{AgentMessageRow, AgentThreadDetail, AgentThreadRow};
use crate::storage::message_repository::{AnonymousMessageRow, NormalMessageDetailRow};
use crate::storage::send_queue_repository::SendQueueRow;
use crate::storage::temp_mailbox_repository::TempMailboxRow;
use crate::storage::verification_repository::RecentVerificationCodeRow;

use super::*;

#[test]
fn temp_mailbox_row_maps_to_command_dto() {
    let row = TempMailboxRow {
        id: "temp_1".to_string(),
        email_address: "code@example.test".to_string(),
        provider_id: "mailtm".to_string(),
        provider_label: "Mail.tm".to_string(),
        domain: Some("example.test".to_string()),
        local_part: Some("code".to_string()),
        easyemail_mailbox_id: Some("session_1".to_string()),
        source_id: Some("src_1".to_string()),
        visibility_state: "anonymous".to_string(),
        lifecycle_state: "active".to_string(),
        lease_expires_at: Some("2026-06-12T01:00:00Z".to_string()),
        upgraded_account_id: None,
        raw_provider_snapshot_json: "{\"safe\":true}".to_string(),
        created_at: "2026-06-12T00:00:00Z".to_string(),
        updated_at: "2026-06-12T00:00:00Z".to_string(),
    };

    let dto = temp_mailbox_row_to_dto(row);

    assert_eq!(dto.id, "temp_1");
    assert_eq!(dto.email_address, "code@example.test");
    assert_eq!(dto.provider_id, "mailtm");
    assert_eq!(dto.provider_label, "Mail.tm");
    assert_eq!(dto.visibility_state, "anonymous");
    assert_eq!(dto.easyemail_mailbox_id, Some("session_1".to_string()));
}

#[test]
fn anonymous_message_row_maps_to_command_dto() {
    let row = AnonymousMessageRow {
        message_id: "msg_1".to_string(),
        temp_mailbox_id: "temp_1".to_string(),
        received_address: "code@example.test".to_string(),
        provider_label: "Mail.tm".to_string(),
        subject: "Your code is 123456".to_string(),
        from_address: "noreply@example.test".to_string(),
        snippet: "Use 123456 to continue.".to_string(),
        observed_at: "2026-06-12T00:10:00Z".to_string(),
        lifecycle_state: "active".to_string(),
        local_state: message_local_state_for_test(),
    };

    let dto = anonymous_message_row_to_dto(row);

    assert_eq!(dto.message_id, "msg_1");
    assert_eq!(dto.received_address, "code@example.test");
    assert_eq!(dto.provider_label, "Mail.tm");
    assert_eq!(dto.subject, "Your code is 123456");
    assert!(dto.is_read);
    assert_eq!(dto.local_folder, "inbox");
    assert_eq!(dto.labels, vec!["Follow up".to_string()]);
}

#[test]
fn refresh_result_maps_to_command_dto() {
    let result = TempRefreshResult {
        fetched_count: 3,
        inserted_count: 2,
        skipped_count: 1,
        refreshed_mailbox_ids: vec!["temp_1".to_string()],
        skipped_mailbox_ids: vec!["temp_2".to_string()],
    };

    let dto = refresh_result_to_dto(result);

    assert_eq!(dto.fetched_count, 3);
    assert_eq!(dto.inserted_count, 2);
    assert_eq!(dto.skipped_count, 1);
    assert_eq!(dto.refreshed_mailbox_ids, vec!["temp_1".to_string()]);
    assert_eq!(dto.skipped_mailbox_ids, vec!["temp_2".to_string()]);
}

#[test]
fn verification_code_row_maps_to_command_dto() {
    let row = recent_code_row_for_test();

    let dto = verification_code_row_to_dto(row);

    assert_eq!(dto.code, "123456");
    assert_eq!(dto.message_id, "msg_1");
    assert_eq!(dto.temp_mailbox_id, Some("temp_1".to_string()));
    assert_eq!(dto.received_address, "code@example.test");
    assert_eq!(dto.source_id, "src_1");
}

#[test]
fn verification_poll_result_maps_to_command_dto() {
    let result = VerificationPollResult {
        refresh: TempRefreshResult {
            fetched_count: 1,
            inserted_count: 1,
            skipped_count: 0,
            refreshed_mailbox_ids: vec!["temp_1".to_string()],
            skipped_mailbox_ids: Vec::new(),
        },
        detected_code: Some(recent_code_row_for_test()),
    };

    let dto = verification_poll_result_to_dto(result);

    assert_eq!(dto.refresh.inserted_count, 1);
    assert_eq!(dto.detected_code.expect("code").code, "123456");
}

#[test]
fn temp_upgrade_returns_account_and_mailbox_dtos() {
    let result = PromoteTempMailboxResult {
        account: account_row_for_test(),
        mailbox: temp_mailbox_row_for_test(),
    };

    let dto = promote_result_to_dto(result);

    assert_eq!(dto.account.kind, "normal_upgraded_temp");
    assert_eq!(dto.mailbox.visibility_state, "upgraded");
}

#[test]
fn normal_message_detail_does_not_expose_secret_metadata() {
    let detail = NormalMessageDetailRow {
        message_id: "msg_1".to_string(),
        account_id: "acct_1".to_string(),
        thread_key: Some("rfc:root@example.test".to_string()),
        received_address: "user@example.test".to_string(),
        subject: "Welcome".to_string(),
        from_address: "noreply@example.test".to_string(),
        snippet: "Hello".to_string(),
        observed_at: "2026-06-12T00:10:00Z".to_string(),
        body_text: Some("Hello".to_string()),
        body_html: None,
        body_cache_state: "cached".to_string(),
        draft_cc_addresses: Vec::new(),
        draft_bcc_addresses: Vec::new(),
        credential_ref_id: Some("cred_1".to_string()),
        secret_key: Some("secret://imap/account-1".to_string()),
        local_state: message_local_state_for_test(),
    };

    let dto = normal_message_detail_to_dto(detail);
    let serialized = serde_json::to_string(&dto).expect("serialize dto");

    assert!(!serialized.contains("secret://imap/account-1"));
    assert!(!serialized.contains("credential_ref_id"));
}

#[test]
fn newsletter_subscription_row_maps_to_command_dto() {
    let dto = newsletter_subscription_row_to_dto(NewsletterSubscriptionRow {
        id: "list:example".to_string(),
        list_id: "Example <example.test>".to_string(),
        sender_address: "Example <updates@example.test>".to_string(),
        name: "Example".to_string(),
        received_message_count: 3,
        unread_message_count: 1,
        last_received_at: "2026-06-12T00:20:00Z".to_string(),
        unsubscribe_methods: vec!["<mailto:unsubscribe@example.test>".to_string()],
        spam: false,
        hidden: false,
    });

    assert_eq!(dto.id, "list:example");
    assert_eq!(dto.name, "Example");
    assert_eq!(dto.received_message_count, 3);
    assert_eq!(dto.unread_message_count, 1);
    assert_eq!(
        dto.unsubscribe_methods,
        vec!["<mailto:unsubscribe@example.test>".to_string()]
    );
}

#[test]
fn newsletter_subscription_action_dto_reports_hidden_state() {
    let dto = NewsletterSubscriptionActionDto {
        account_id: "acct_1".to_string(),
        subscription_id: "list:example".to_string(),
        hidden: true,
        changed: true,
    };

    assert_eq!(dto.account_id, "acct_1");
    assert_eq!(dto.subscription_id, "list:example");
    assert!(dto.hidden);
    assert!(dto.changed);
}

#[test]
fn mail_taxonomy_row_maps_to_command_dto() {
    let dto = mail_taxonomy_row_to_dto(MailTaxonomyItemRow {
        id: "mailtax_label_client".to_string(),
        kind: "label".to_string(),
        name: "Client".to_string(),
        parent_id: None,
        color: "#06b6d4".to_string(),
        sort_order: 10,
        system: false,
        created_at: "2026-06-17T20:00:00Z".to_string(),
        updated_at: "2026-06-17T20:00:00Z".to_string(),
    });

    assert_eq!(dto.id, "mailtax_label_client");
    assert_eq!(dto.kind, "label");
    assert_eq!(dto.name, "Client");
    assert_eq!(dto.parent_id, None);
    assert_eq!(dto.color, "#06b6d4");
    assert!(!dto.system);
}

#[test]
fn normal_message_row_dto_exposes_newsletter_subscription_id() {
    let mut row = normal_account_message_row_for_test();
    row.local_state.newsletter_subscription_id = Some("list:example".to_string());

    let dto = normal_message_row_to_dto(row);

    assert_eq!(
        dto.newsletter_subscription_id,
        Some("list:example".to_string())
    );
}

#[test]
fn send_queue_row_dto_does_not_expose_secret_metadata() {
    let row = SendQueueRow {
        id: "send_1".to_string(),
        account_id: "acct_send".to_string(),
        source_id: "src_smtp".to_string(),
        message_id: "msg_outgoing".to_string(),
        target_address: "target@example.test".to_string(),
        cc_addresses: vec!["cc@example.test".to_string()],
        bcc_addresses: vec!["bcc@example.test".to_string()],
        subject: "Hello".to_string(),
        status: "queued".to_string(),
        attempt_count: 0,
        next_retry_at: None,
        last_error_code: None,
        last_error_message: None,
        created_at: "2026-06-12T01:00:00Z".to_string(),
        updated_at: "2026-06-12T01:00:00Z".to_string(),
        sent_at: None,
        credential_ref_id: Some("cred_1".to_string()),
        secret_key: Some("secret://smtp/account-1".to_string()),
    };

    let dto = send_queue_row_to_dto(row);
    let serialized = serde_json::to_string(&dto).expect("serialize dto");

    assert!(!serialized.contains("secret://smtp/account-1"));
    assert!(!serialized.contains("credential_ref_id"));
    assert!(serialized.contains("cc@example.test"));
    assert!(serialized.contains("bcc@example.test"));
}

#[test]
fn agent_thread_detail_dto_does_not_expose_secret_metadata() {
    let detail = AgentThreadDetail {
        thread: AgentThreadRow {
            id: "agthread_1".to_string(),
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            status: "awaiting_reply".to_string(),
            last_outgoing_message_id: Some("msg_outgoing".to_string()),
            last_incoming_message_id: None,
            correlation_key: "corr_1".to_string(),
            created_at: "2026-06-12T02:20:00Z".to_string(),
            updated_at: "2026-06-12T02:20:00Z".to_string(),
            completed_at: None,
        },
        messages: vec![AgentMessageRow {
            id: "agmsg_1".to_string(),
            thread_id: "agthread_1".to_string(),
            message_id: "msg_outgoing".to_string(),
            direction: "outgoing".to_string(),
            semantic_role: "task_request".to_string(),
            parsed_status: Some("queued".to_string()),
            parsed_payload_json: "{\"secret_key\":\"secret://smtp/acct_agent\"}".to_string(),
            created_at: "2026-06-12T02:20:00Z".to_string(),
        }],
    };

    let dto = agent_thread_detail_to_dto(detail);
    let serialized = serde_json::to_string(&dto).expect("serialize dto");

    assert!(!serialized.contains("secret://smtp/acct_agent"));
    assert!(!serialized.contains("secret_key"));
}

fn account_row_for_test() -> AccountRow {
    AccountRow {
        id: "acct_1".to_string(),
        scope: "normal".to_string(),
        kind: "normal_upgraded_temp".to_string(),
        display_name: "code@example.test".to_string(),
        primary_address: Some("code@example.test".to_string()),
        provider_label: Some("Fake Provider".to_string()),
        status: "ready".to_string(),
        auth_status: "not_required".to_string(),
        receive_status: "enabled".to_string(),
        send_status: "unsupported".to_string(),
        listed_in_all_accounts: true,
    }
}

fn message_local_state_for_test() -> MessageLocalState {
    MessageLocalState {
        is_read: true,
        is_starred: false,
        is_archived: false,
        is_important: false,
        local_folder: "inbox".to_string(),
        labels: vec!["Follow up".to_string()],
        newsletter_subscription_id: None,
    }
}

fn normal_account_message_row_for_test() -> NormalAccountMessageRow {
    NormalAccountMessageRow {
        account_id: "acct_1".to_string(),
        message_id: "msg_1".to_string(),
        thread_key: Some("rfc:root@example.test".to_string()),
        source_id: "src_1".to_string(),
        folder_id: "folder_inbox".to_string(),
        provider_message_id: "uid_1".to_string(),
        received_address: "user@example.test".to_string(),
        provider_label: "Manual IMAP".to_string(),
        subject: "Newsletter".to_string(),
        from_address: "Updates <updates@example.test>".to_string(),
        snippet: "Update body".to_string(),
        observed_at: "2026-06-12T00:10:00Z".to_string(),
        local_state: message_local_state_for_test(),
    }
}

fn temp_mailbox_row_for_test() -> TempMailboxRow {
    TempMailboxRow {
        id: "temp_1".to_string(),
        email_address: "code@example.test".to_string(),
        provider_id: "fake".to_string(),
        provider_label: "Fake Provider".to_string(),
        domain: Some("example.test".to_string()),
        local_part: Some("code".to_string()),
        easyemail_mailbox_id: Some("session_1".to_string()),
        source_id: Some("src_1".to_string()),
        visibility_state: "upgraded".to_string(),
        lifecycle_state: "active".to_string(),
        lease_expires_at: None,
        upgraded_account_id: Some("acct_1".to_string()),
        raw_provider_snapshot_json: "{}".to_string(),
        created_at: "2026-06-12T00:00:00Z".to_string(),
        updated_at: "2026-06-12T00:20:00Z".to_string(),
    }
}

fn recent_code_row_for_test() -> RecentVerificationCodeRow {
    RecentVerificationCodeRow {
        id: "vcode_1".to_string(),
        message_id: "msg_1".to_string(),
        temp_mailbox_id: Some("temp_1".to_string()),
        source_id: "src_1".to_string(),
        account_scope: "anonymous".to_string(),
        received_address: "code@example.test".to_string(),
        code: "123456".to_string(),
        issuer_hint: Some("example.test".to_string()),
        target_service_hint: Some("github".to_string()),
        confidence: 0.95,
        expires_at: None,
        extracted_at: "2026-06-12T00:11:00Z".to_string(),
        subject: "Your code is 123456".to_string(),
        from_address: "noreply@example.test".to_string(),
        observed_at: "2026-06-12T00:10:00Z".to_string(),
    }
}
