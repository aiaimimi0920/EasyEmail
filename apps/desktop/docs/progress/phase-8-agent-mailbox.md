# Phase 8: Agent mailbox MVP

Source spec section: Milestone 8.

## Tasks

- [x] Agent account scope workflow exists.
- [x] `agent_services` schema/repository exists.
- [x] `agent_threads` schema/repository exists.
- [x] `agent_messages` schema/repository exists.
- [x] Add remote Agent service UI/command exists.
- [x] Create Agent task UI/command exists.
- [x] Send task mail flow exists.
- [x] Collect Agent replies and link by headers where possible.
- [x] Unmatched known-Agent reply enters `needs_attention`.

## Notes

Agent mailbox accounts must never appear in normal all accounts.

## Evidence

- Agent account and repository implementation:
  - Commit `9712ebd feat: add agent mailbox repositories`.
  - Targeted tests covered Agent account exclusion from normal accounts, Agent service trust persistence, Agent thread detail loading, and migration smoke coverage.
- Agent task send flow:
  - Commit `df4e7e1 feat: send agent task mail`.
  - Targeted tests covered sender scope enforcement, blocked/restricted service handling, trusted task queue creation, outgoing Agent message insertion, and send queue insertion.
- Agent reply association:
  - Commit `f007a54 feat: associate agent replies`.
  - Red tests failed first because `AgentReplyAssociationRequest` and `associate_incoming_agent_reply` did not exist.
  - Green tests passed for `incoming_reply_links_by_in_reply_to` and `unmatched_agent_reply_goes_to_needs_attention`.
  - Regression command `cargo test --manifest-path src-tauri/Cargo.toml agent_service` passed 7 tests.
- Agent commands and UI:
  - Commit `726dbfb feat: add agent mailbox UI`.
  - DTO redaction red test failed first because `agent_thread_detail_to_dto` did not exist.
  - Green test `agent_thread_detail_dto_does_not_expose_secret_metadata` passed.
  - `npm run build` passed and `cargo check --manifest-path src-tauri/Cargo.toml` passed.
  - `cargo test --manifest-path src-tauri/Cargo.toml commands::tests` passed 9 tests.
- Phase closeout:
  - `npm run verify` passed: production build, `cargo fmt`, 82 Rust tests, and `cargo check`.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
