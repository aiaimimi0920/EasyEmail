# Phase 7: SMTP and send queue

Source spec section: Milestone 7.

## Tasks

- [x] SMTP adapter exists.
- [x] `send_queue` schema/repository exists.
- [x] Draft/send commands exist.
- [x] SendQueueWorker exists.
- [x] Send status UI exists.
- [x] Retry/backoff exists.
- [x] Anonymous and receive-only accounts are blocked from sending.

## Notes

Sending must use the queue and must not block the UI on SMTP.

## Evidence

- Plan: `../superpowers/plans/2026-06-12-easyemailam-smtp-send-queue.md`.
- SMTP adapter boundary:
  - Commit `8b7adb9 feat: add smtp adapter boundary`.
  - Tests: `fake_smtp_adapter_sends_message`, `native_smtp_adapter_reports_unsupported_until_dependency_exists`.
- Send queue repository:
  - Commit `097255a feat: add send queue repository`.
  - Tests: `send_queue_repository_enqueues_queued_job`, `claim_next_due_send_marks_job_sending_once`, `migrations_apply_cleanly`.
- Send service validation/enqueue:
  - Commit `6ce748b feat: enqueue normal account sends`.
  - Tests: `send_message_requires_send_enabled`, `anonymous_account_cannot_send`, `send_message_enqueues_without_calling_smtp`.
- SendQueueWorker:
  - Commit `4e77bdb feat: process send queue jobs`.
  - Tests: `smtp_retryable_error_requeues_with_backoff`, `smtp_auth_failure_sets_action_required`, `send_queue_worker_is_idempotent`.
- Commands/UI:
  - Commit `3f6fc62 feat: add send queue UI`.
  - Red test first failed on missing `send_queue_row_to_dto`.
  - Green test: `send_queue_row_dto_does_not_expose_secret_metadata`.
  - Compile checks: `npm run build` passed; `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Clippy fix:
  - Commit `ea73eaf refactor: group outgoing message insert input`.
  - Root cause: `insert_outgoing_message` used 8 parameters and violated `clippy::too_many_arguments`.
- Full phase verification:
  - `npm run verify` passed: Vite/TypeScript build, Rust fmt, Rust tests, and Rust check all passed.
  - `cargo test --manifest-path src-tauri/Cargo.toml` inside verify passed with 72 tests.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
