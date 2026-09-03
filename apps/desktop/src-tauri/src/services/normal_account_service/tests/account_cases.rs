use super::*;

#[test]
fn manual_account_create_saves_credential_ref_not_secret() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let imap_adapter = FakeImapAdapter::with_connection_success();
    let smtp_adapter = FakeSmtpAdapter::success();

    let result = add_manual_imap_account(
        &connection,
        &vault,
        &imap_adapter,
        &smtp_adapter,
        manual_request(),
        "2026-06-12T00:00:00Z".to_string(),
    )
    .expect("add manual imap");

    assert_eq!(result.account.kind, "normal_long_lived");
    assert_eq!(result.account.send_status, "enabled");
    assert!(vault
        .exists(&result.credential.secret_key)
        .expect("secret exists"));
    let smtp_source = get_smtp_source_for_account(&connection, &result.account.id)
        .expect("query smtp source")
        .expect("smtp source exists");
    assert_eq!(smtp_source.config.host, "smtp.example.test");
    assert_eq!(smtp_source.config.port, 465);
    assert!(vault
        .exists(&smtp_source.secret_key)
        .expect("smtp secret exists"));
    assert_no_sqlite_value_contains(&connection, "app-password");
}

#[test]
fn manual_account_rejects_plaintext_mail_security() {
    let error = normalize_manual_imap_account_request(ManualImapAccountRequest {
        imap_security: "plain".to_string(),
        smtp_security: "none".to_string(),
        ..manual_request()
    })
    .expect_err("plaintext security rejected");

    assert_eq!(error.code, "manual_mail_security_invalid");
    assert_eq!(error.category, ErrorCategory::Validation);
}

#[test]
fn imap_auth_failure_sets_auth_failed_status() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let imap_adapter = FakeImapAdapter::auth_failed();
    let smtp_adapter = FakeSmtpAdapter::success();

    let error = add_manual_imap_account(
        &connection,
        &vault,
        &imap_adapter,
        &smtp_adapter,
        ManualImapAccountRequest {
            imap_password: "bad-password".to_string(),
            ..manual_request()
        },
        "2026-06-12T00:00:00Z".to_string(),
    )
    .expect_err("auth failure");

    assert_eq!(error.code, "imap_auth_failed");
    assert_no_normal_account_created(&connection);
}

#[test]
fn smtp_auth_failure_keeps_receive_account_but_disables_sending() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let imap_adapter = FakeImapAdapter::with_connection_success();
    let smtp_adapter = FakeSmtpAdapter::auth_failure();

    let result = add_manual_imap_account(
        &connection,
        &vault,
        &imap_adapter,
        &smtp_adapter,
        manual_request(),
        "2026-06-12T00:00:00Z".to_string(),
    )
    .expect("smtp failure should not block receiving account");

    assert_eq!(result.account.receive_status, "enabled");
    assert_eq!(result.account.send_status, "auth_failed");
    assert!(get_smtp_source_for_account(&connection, &result.account.id)
        .expect("query smtp source")
        .is_some());
}
