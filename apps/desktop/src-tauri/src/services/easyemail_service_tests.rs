use rusqlite::Connection;
use serde_json::json;

use crate::easyemail::fake::FakeEasyEmailAdapter;
use crate::easyemail::models::{
    CreateTempMailboxRequest, EasyEmailObservedMessage, EasyEmailTempMailbox,
};
use crate::error::{ActionRequired, ErrorCategory};
use crate::storage::db::open_in_memory_database;
use crate::storage::migrations::run_migrations;
use crate::storage::settings_repository::save_easyemail_service_url;
use crate::storage::temp_mailbox_repository::get_temp_mailbox;
use crate::storage::temp_mailbox_repository::insert_temp_mailbox;

use super::*;

fn test_connection() -> Connection {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");
    save_easyemail_service_url(&connection, "http://127.0.0.1:8080", "2026-06-12T00:00:00Z")
        .expect("save EasyEmail URL");
    connection
}

#[test]
fn blank_easyemail_service_url_is_rejected() {
    let error = validate_easyemail_service_url("   ").expect_err("blank URL rejected");

    assert_eq!(error.code, "easyemail_service_url_invalid");
    assert_eq!(error.category, ErrorCategory::Validation);
    assert_eq!(error.action_required, ActionRequired::EditSettings);
}

#[test]
fn invalid_easyemail_service_url_is_rejected() {
    let error =
        validate_easyemail_service_url("ftp://127.0.0.1:8080").expect_err("invalid URL rejected");

    assert_eq!(error.code, "easyemail_service_url_invalid");
    assert_eq!(error.category, ErrorCategory::Validation);
    assert_eq!(error.action_required, ActionRequired::EditSettings);
}

#[test]
fn easyemail_service_url_rejects_credentials_paths_and_remote_plaintext() {
    for value in [
        "https://user:password@example.test",
        "https://example.test/api",
        "https://example.test?token=secret",
        "http://example.test",
    ] {
        let error = validate_easyemail_service_url(value).expect_err("unsafe URL rejected");
        assert_eq!(error.code, "easyemail_service_url_invalid", "{value}");
    }
}

#[test]
fn easyemail_service_url_allows_loopback_http_and_remote_https() {
    assert_eq!(
        validate_easyemail_service_url(" http://127.0.0.1:8080/ ").expect("loopback URL"),
        "http://127.0.0.1:8080"
    );
    assert_eq!(
        validate_easyemail_service_url("http://[::1]:8080/").expect("IPv6 loopback URL"),
        "http://[::1]:8080"
    );
    assert_eq!(
        validate_easyemail_service_url("https://easyemail.example.test/").expect("HTTPS URL"),
        "https://easyemail.example.test"
    );
}

#[test]
fn create_temp_mailbox_saves_canonical_fields() {
    let connection = test_connection();
    let adapter = FakeEasyEmailAdapter::with_mailbox(EasyEmailTempMailbox {
        email_address: "code@example.test".to_string(),
        provider_id: "mailtm".to_string(),
        provider_label: "Mail.tm".to_string(),
        easyemail_mailbox_id: Some("session_123".to_string()),
        lease_expires_at: Some("2026-06-12T01:00:00Z".to_string()),
        raw_provider_snapshot_json: json!({"ignoredProviderInternals": true}),
    });

    let mailbox = create_temp_mailbox(
        &connection,
        &adapter,
        CreateTempMailboxServiceRequest {
            api_token: None,
            request: CreateTempMailboxRequest {
                target_service: Some("github".to_string()),
                provider_selection: None,
                domain_selection: None,
                local_part: None,
                note: Some("register github".to_string()),
            },
        },
        "2026-06-12T00:02:00Z".to_string(),
    )
    .expect("create temp mailbox");

    let row = get_temp_mailbox(&connection, &mailbox.id)
        .expect("load temp mailbox")
        .expect("temp mailbox exists");

    assert_eq!(row.email_address, "code@example.test");
    assert_eq!(row.provider_id, "mailtm");
    assert_eq!(row.provider_label, "Mail.tm");
    assert_eq!(row.easyemail_mailbox_id, Some("session_123".to_string()));
    assert_eq!(
        row.lease_expires_at,
        Some("2026-06-12T01:00:00Z".to_string())
    );
    assert_eq!(row.visibility_state, "anonymous");
    assert_eq!(row.lifecycle_state, "active");
}

#[test]
fn create_temp_mailbox_stores_redacted_provider_snapshot() {
    let connection = test_connection();
    let raw_snapshot = json!({
        "session": {
            "id": "session_opaque",
            "emailAddress": "raw@example.test",
            "accessToken": "provider-access-token"
        },
        "providerSpecific": {
            "nested": { "value": 42, "password": "provider-password" }
        }
    });
    let adapter = FakeEasyEmailAdapter::with_mailbox(EasyEmailTempMailbox {
        email_address: "raw@example.test".to_string(),
        provider_id: "opaque-provider".to_string(),
        provider_label: "Opaque Provider".to_string(),
        easyemail_mailbox_id: Some("session_opaque".to_string()),
        lease_expires_at: None,
        raw_provider_snapshot_json: raw_snapshot.clone(),
    });

    let mailbox = create_temp_mailbox(
        &connection,
        &adapter,
        CreateTempMailboxServiceRequest {
            api_token: None,
            request: CreateTempMailboxRequest::default(),
        },
        "2026-06-12T00:03:00Z".to_string(),
    )
    .expect("create temp mailbox");
    let row = get_temp_mailbox(&connection, &mailbox.id)
        .expect("load temp mailbox")
        .expect("temp mailbox exists");
    let stored_raw: serde_json::Value =
        serde_json::from_str(&row.raw_provider_snapshot_json).expect("stored raw JSON");

    assert_eq!(row.provider_id, "opaque-provider");
    assert_eq!(stored_raw["session"]["id"], "session_opaque");
    assert_eq!(stored_raw["providerSpecific"]["nested"]["value"], 42);
    assert_eq!(stored_raw["session"]["accessToken"], "[REDACTED]");
    assert_eq!(
        stored_raw["providerSpecific"]["nested"]["password"],
        "[REDACTED]"
    );
    assert!(!stored_raw.to_string().contains("provider-access-token"));
    assert!(!stored_raw.to_string().contains("provider-password"));
}

#[test]
fn temp_mailbox_lease_comparison_respects_rfc3339_offsets() {
    let connection = test_connection();
    let mailbox = TempMailbox::from_easyemail(
        "offset@example.test".to_string(),
        "mailtm".to_string(),
        "Mail.tm".to_string(),
        Some("session_offset".to_string()),
        Some("2026-06-12T08:00:00+08:00".to_string()),
        "{}".to_string(),
        "2026-06-11T23:00:00Z".to_string(),
    );
    insert_temp_mailbox(&connection, &mailbox).expect("insert offset mailbox");
    let row = get_temp_mailbox(&connection, &mailbox.id)
        .expect("load mailbox")
        .expect("mailbox exists");

    assert!(!temp_mailbox_is_past_lease(&row, "2026-06-11T23:59:59Z"));
    assert!(temp_mailbox_is_past_lease(&row, "2026-06-12T00:00:00Z"));
}

#[test]
fn provider_rate_limit_returns_rate_limit_error() {
    let connection = test_connection();
    let adapter = FakeEasyEmailAdapter::failing(rate_limit_error_for_test());

    let error = create_temp_mailbox(
        &connection,
        &adapter,
        CreateTempMailboxServiceRequest {
            api_token: Some("one-shot-token".to_string()),
            request: CreateTempMailboxRequest::default(),
        },
        "2026-06-12T00:04:00Z".to_string(),
    )
    .expect_err("rate limit should fail");

    assert_eq!(error.category, ErrorCategory::RateLimit);
    assert_eq!(error.action_required, ActionRequired::Wait);
    assert!(error.retryable);
}

#[test]
fn easyemail_token_is_not_present_in_error_dto_metadata() {
    let connection = test_connection();
    let adapter = FakeEasyEmailAdapter::failing(rate_limit_error_for_test());

    let error = create_temp_mailbox(
        &connection,
        &adapter,
        CreateTempMailboxServiceRequest {
            api_token: Some("one-shot-token".to_string()),
            request: CreateTempMailboxRequest::default(),
        },
        "2026-06-12T00:05:00Z".to_string(),
    )
    .expect_err("rate limit should fail");
    let dto = error.to_dto();

    assert!(!dto.metadata.to_string().contains("one-shot-token"));
    assert!(!dto
        .technical_message
        .unwrap_or_default()
        .contains("one-shot-token"));
}

#[test]
fn refresh_anonymous_fetches_only_active_anonymous_mailboxes() {
    let connection = test_connection();
    let active = TempMailbox::from_easyemail(
        "active@example.test".to_string(),
        "mailtm".to_string(),
        "Mail.tm".to_string(),
        Some("session_active".to_string()),
        None,
        "{}".to_string(),
        "2026-06-12T00:00:00Z".to_string(),
    );
    let expired = TempMailbox::from_easyemail(
        "expired@example.test".to_string(),
        "mailtm".to_string(),
        "Mail.tm".to_string(),
        Some("session_expired".to_string()),
        None,
        "{}".to_string(),
        "2026-06-12T00:00:00Z".to_string(),
    );
    let upgraded = TempMailbox::from_easyemail(
        "upgraded@example.test".to_string(),
        "mailtm".to_string(),
        "Mail.tm".to_string(),
        Some("session_upgraded".to_string()),
        None,
        "{}".to_string(),
        "2026-06-12T00:00:00Z".to_string(),
    );
    insert_temp_mailbox(&connection, &active).expect("insert active");
    insert_temp_mailbox(&connection, &expired).expect("insert expired");
    insert_temp_mailbox(&connection, &upgraded).expect("insert upgraded");
    connection
        .execute(
            "UPDATE temp_mailboxes SET lifecycle_state = 'expired' WHERE id = ?1",
            rusqlite::params![expired.id],
        )
        .expect("mark expired");
    connection
        .execute(
            "UPDATE temp_mailboxes SET visibility_state = 'upgraded' WHERE id = ?1",
            rusqlite::params![upgraded.id],
        )
        .expect("mark upgraded");
    let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
        "session_active",
        vec![observed_message_for_service(
            "observed_active",
            "session_active",
        )],
    );

    let result = refresh_anonymous_temp_mailboxes(
        &connection,
        &adapter,
        TempRefreshAnonymousRequest { api_token: None },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("refresh anonymous");

    assert_eq!(adapter.fetch_calls(), vec!["session_active".to_string()]);
    assert_eq!(result.fetched_count, 1);
    assert_eq!(result.inserted_count, 1);
    assert_eq!(result.refreshed_mailbox_ids, vec![active.id]);
    assert_eq!(result.skipped_count, 2);
}

#[test]
fn expired_temp_mailbox_is_skipped_unless_forced() {
    let connection = test_connection();
    let expired = TempMailbox::from_easyemail(
        "expired@example.test".to_string(),
        "mailtm".to_string(),
        "Mail.tm".to_string(),
        Some("session_expired".to_string()),
        None,
        "{}".to_string(),
        "2026-06-12T00:00:00Z".to_string(),
    );
    insert_temp_mailbox(&connection, &expired).expect("insert expired");
    connection
        .execute(
            "UPDATE temp_mailboxes SET lifecycle_state = 'expired' WHERE id = ?1",
            rusqlite::params![expired.id],
        )
        .expect("mark expired");
    let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
        "session_expired",
        vec![observed_message_for_service(
            "observed_expired",
            "session_expired",
        )],
    );

    let skipped = refresh_temp_mailbox(
        &connection,
        &adapter,
        TempRefreshMailboxRequest {
            temp_mailbox_id: expired.id.clone(),
            api_token: None,
            force: false,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("skip expired");
    let forced = refresh_temp_mailbox(
        &connection,
        &adapter,
        TempRefreshMailboxRequest {
            temp_mailbox_id: expired.id.clone(),
            api_token: None,
            force: true,
        },
        "2026-06-12T00:11:00Z".to_string(),
    )
    .expect("force expired");

    assert_eq!(adapter.fetch_calls(), vec!["session_expired".to_string()]);
    assert_eq!(skipped.skipped_count, 1);
    assert_eq!(skipped.inserted_count, 0);
    assert_eq!(forced.fetched_count, 1);
    assert_eq!(forced.inserted_count, 1);
}

#[test]
fn refresh_temp_mailbox_extracts_codes_for_inserted_messages() {
    let connection = test_connection();
    let temp = TempMailbox::from_easyemail(
        "code@example.test".to_string(),
        "mailtm".to_string(),
        "Mail.tm".to_string(),
        Some("session_code".to_string()),
        None,
        "{}".to_string(),
        "2026-06-12T00:00:00Z".to_string(),
    );
    insert_temp_mailbox(&connection, &temp).expect("insert temp");
    let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
        "session_code",
        vec![observed_message_for_service(
            "observed_code",
            "session_code",
        )],
    );

    refresh_temp_mailbox(
        &connection,
        &adapter,
        TempRefreshMailboxRequest {
            temp_mailbox_id: temp.id.clone(),
            api_token: None,
            force: false,
        },
        "2026-06-12T00:15:00Z".to_string(),
    )
    .expect("refresh temp");

    let rows = crate::storage::verification_repository::list_recent_verification_codes(
        &connection,
        crate::storage::verification_repository::RecentVerificationCodeFilter {
            temp_mailbox_id: Some(temp.id),
            limit: 10,
        },
    )
    .expect("list codes");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].code, "123456");
}

fn rate_limit_error_for_test() -> AppError {
    AppError {
        code: "easyemail_rate_limited".to_string(),
        category: ErrorCategory::RateLimit,
        user_message: "EasyEmail is rate limiting mailbox creation. Wait and retry.".to_string(),
        technical_message: Some("HTTP 429 at /mail/mailboxes/open".to_string()),
        retryable: true,
        action_required: ActionRequired::Wait,
        correlation_id: "corr_rate_limited".to_string(),
        metadata: Box::new(json!({"endpoint": "/mail/mailboxes/open", "status": 429})),
    }
}

fn observed_message_for_service(id: &str, session_id: &str) -> EasyEmailObservedMessage {
    EasyEmailObservedMessage {
        id: id.to_string(),
        session_id: session_id.to_string(),
        provider_instance_id: "provider_instance_1".to_string(),
        observed_at: "2026-06-12T00:10:00Z".to_string(),
        sender: Some("noreply@example.test".to_string()),
        subject: Some("Your code is 123456".to_string()),
        text_body: Some("Use 123456 to continue.".to_string()),
        html_body: None,
        raw_json: json!({"id": id, "sessionId": session_id}),
    }
}
