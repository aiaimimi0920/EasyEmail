# Phase 3: Temporary mailbox fetch and anonymous aggregation

Source spec section: Milestone 3.

## Tasks

- [x] `EasyEmailAdapter.fetch_temp_messages` exists.
  - Acceptance: HTTP adapter can query EasyEmail observed messages for a specific EasyEmail mailbox/session id with `sync=true`.
  - Evidence: `EasyEmailAdapter::fetch_temp_messages`; `http_fetch_temp_messages_queries_session_with_sync`; `observed_message_maps_canonical_fields`; `fake_adapter_records_fetch_session_ids`.
- [x] TempMailboxFetchWorker or synchronous worker-equivalent exists.
  - Acceptance: refresh logic is isolated from Tauri command glue and can later become a background worker.
  - Evidence: `EasyEmailService::refresh_temp_mailbox`; `refresh_anonymous_fetches_only_active_anonymous_mailboxes`; `expired_temp_mailbox_is_skipped_unless_forced`.
- [x] `temp_refresh_mailbox` command exists.
  - Acceptance: refreshing one mailbox fetches new messages when active and anonymous.
  - Evidence: `temp_refresh_mailbox` command; `refresh_result_maps_to_command_dto`.
- [x] `temp_refresh_anonymous` command exists.
  - Acceptance: refreshes only active anonymous temp mailboxes unless explicitly forced.
  - Evidence: `temp_refresh_anonymous` command; `refresh_result_maps_to_command_dto`.
- [x] `message_list` with `scope=anonymous` exists.
  - Acceptance: anonymous message list returns rows with real received address, provider, message subject/sender/snippet/time.
  - Evidence: `message_list` command; `anonymous_message_row_maps_to_command_dto`; `MessageRepository::list_anonymous_messages`.
- [x] Anonymous mailbox UI exists.
  - Acceptance: UI can refresh anonymous temp mailboxes and display the anonymous message list.
  - Evidence: `src/App.tsx`, `src/App.css`, `npm run build` under `npm run verify`.
- [x] Message deduplication exists.
  - Acceptance: repeated fetches do not duplicate messages or message sources.
  - Evidence: `message_sources(temp_mailbox_id, easyemail_message_id)` unique index; `fetch_temp_messages_is_idempotent`.

## Notes

Phase 3 is complete. Verification evidence:

- Red tests were observed for adapter, repository, service, and command DTO work before implementation.
- Targeted tests passed after implementation:
  - `observed_message_maps_canonical_fields`
  - `fake_adapter_records_fetch_session_ids`
  - `http_fetch_temp_messages_queries_session_with_sync`
  - `fetch_temp_messages_inserts_messages_and_sources`
  - `fetch_temp_messages_is_idempotent`
  - `anonymous_message_query_excludes_upgraded_temp_mailbox`
  - `refresh_anonymous_fetches_only_active_anonymous_mailboxes`
  - `expired_temp_mailbox_is_skipped_unless_forced`
  - `anonymous_message_row_maps_to_command_dto`
  - `refresh_result_maps_to_command_dto`
- Full verification: `npm run verify` passed with 36 Rust tests; `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
