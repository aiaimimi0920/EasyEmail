# Phase 1: Core schema and repositories

Source spec section: Milestone 1.

## Tasks

- [x] `accounts` schema and repository invariants exist.
  - Evidence: `src-tauri/migrations/0001_foundation.sql`, `account_repository.rs`.
- [x] `mailbox_sources` schema exists.
  - Evidence: `0001_foundation.sql`.
- [x] `credential_refs` schema exists.
  - Evidence: `0001_foundation.sql`.
- [x] `temp_mailboxes` schema and repository exist.
  - Evidence: `temp_mailbox_repository.rs`.
- [x] `messages` schema and basic repository exist.
  - Evidence: `message_repository.rs`.
- [x] `message_sources` schema and traceability test exist.
  - Evidence: `message_source_keeps_temp_mailbox_id`.
- [x] `sync_states`, `verification_codes`, and `app_settings` schemas exist.
  - Evidence: `0001_foundation.sql`; app settings repository added in Phase 2.
- [x] Anonymous aggregation query exists.
  - Acceptance: query returns only messages belonging to anonymous temp mailboxes and excludes upgraded/archived mailboxes.
  - Evidence: `MessageRepository::list_anonymous_messages`; `anonymous_message_query_excludes_upgraded_temp_mailbox`.

## Notes

The anonymous aggregation query was implemented in Phase 3 because it depends on fetch/message ingestion behavior.
