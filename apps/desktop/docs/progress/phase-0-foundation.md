# Phase 0: Foundation baseline and gap closure

Source spec section: Milestone 0.

## Tasks

- [x] Tauri skeleton exists and builds.
  - Evidence: executed foundation plan and `npm run verify`.
- [x] SQLite database initialization exists.
  - Evidence: `src-tauri/src/app_state.rs`, `src-tauri/src/storage/db.rs`.
- [x] Migration runner exists and is repeatable.
  - Evidence: `storage::migrations` tests.
- [x] AppState exists.
  - Evidence: `src-tauri/src/app_state.rs`.
- [x] AppError and stable ErrorDto exist.
  - Evidence: `src-tauri/src/error.rs`.
- [x] EventBus skeleton exists.
  - Evidence: `src-tauri/src/events.rs`, `AppState.event_bus`, and `events::tests::event_bus_records_redacted_backend_events`.
- [x] Logging skeleton exists.
  - Evidence: `src-tauri/src/diagnostics.rs`, `AppState.diagnostic_logger`, and diagnostics tests for password/token redaction plus default message-body exclusion.
- [x] Redaction skeleton exists and is tested.
  - Evidence: `src-tauri/src/redaction.rs` tests.
- [x] Health command exists and frontend can call it.
  - Evidence: `commands::health_check`, current React UI.

## Notes

EventBus and logging were named in the original spec but were not required by the first two executed plans. They were closed in the Phase 0 gap-closure pass with backend-only skeletons intended for future workers and commands.

## Evidence

- EventBus skeleton:
  - Commit `54c8bb1 feat: add event bus skeleton`.
  - Red test failed first because `InMemoryEventBus` and `AppEvent` did not exist.
  - Green test `event_bus_records_redacted_backend_events` passed.
  - `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Logging/diagnostics skeleton:
  - Commit `a569de2 feat: add diagnostic logging skeleton`.
  - Red tests failed first because `DiagnosticLogger`, `NewDiagnosticLogEntry`, and `DiagnosticLogLevel` did not exist.
  - Green tests `logs_redact_password_fields`, `logs_redact_oauth_tokens`, and `diagnostic_export_excludes_message_body_by_default` passed.
  - `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Phase 0 closeout:
  - `npm run verify` passed: production build, `cargo fmt`, 86 Rust tests, and `cargo check`.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
