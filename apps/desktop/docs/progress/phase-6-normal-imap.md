# Phase 6: Normal IMAP basics

Source spec section: Milestone 6.

## Tasks

- [x] Manual IMAP account add exists.
- [x] SecretVaultAdapter fake exists.
- [x] Windows Credential Manager adapter exists.
- [x] Fake/real ImapAdapter skeleton exists.
- [x] IMAP connection test exists.
- [x] Initial recent-header sync exists.
- [x] Normal message list/detail and account status display exist.

## Notes

SQLite must store credential references only, never plaintext mailbox secrets.

## Evidence

- Plan: `../superpowers/plans/2026-06-12-easyemailam-normal-imap-basics.md`.
- Secret vault and credential reference boundary:
  - Commit `645cdad feat: add secret vault boundary`.
  - Tests: `fake_secret_vault_round_trips_without_sqlite`, `credential_ref_repository_never_stores_secret_value`, `windows_credential_manager_adapter_exists`.
- IMAP adapter boundary:
  - Commit `fe899bd feat: add imap adapter boundary`.
  - Tests: `fake_imap_adapter_tests_connection_success`, `native_imap_adapter_reports_unsupported_until_dependency_exists`.
- Manual normal IMAP account/sync:
  - Commit `e48b297 feat: add manual imap account sync`.
  - Red tests first failed on missing service/storage APIs.
  - Green tests: `manual_account_create_saves_credential_ref_not_secret`, `normal_account_initial_sync_saves_messages`, `imap_auth_failure_sets_auth_failed_status`, `migrations_apply_cleanly`.
- Commands/UI:
  - Commit `85fbfa7 feat: add normal imap account UI`.
  - Red test first failed on missing `NormalMessageDetailRow` and `normal_message_detail_to_dto`.
  - Green test: `normal_message_detail_does_not_expose_secret_metadata`.
  - Compile checks: `npm run build` passed; `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Full phase verification:
  - `npm run verify` passed: Vite/TypeScript build, Rust fmt, Rust tests, and Rust check all passed.
  - `cargo test --manifest-path src-tauri/Cargo.toml` inside verify passed with 61 tests.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
