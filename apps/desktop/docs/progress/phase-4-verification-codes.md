# Phase 4: Verification codes and waiting mode

Source spec section: Milestone 4.

## Tasks

- [x] VerificationCodeService exists.
  - Evidence: `src-tauri/src/services/verification_service.rs`; `reclassify_message_updates_existing_code`; `wait_for_code_polling_reports_detected_code`.
- [x] Lightweight verification-code classification exists.
  - Evidence: `src-tauri/src/domain/verification.rs`; `extracts_common_6_digit_verification_code`; `extracts_code_from_subject_or_body`.
- [x] `verification_list_recent` command exists.
  - Evidence: `verification_list_recent` in `src-tauri/src/commands.rs`; `verification_code_row_maps_to_command_dto`.
- [x] `verification_reclassify_message` command exists.
  - Evidence: `verification_reclassify_message` in `commands.rs`; `reclassify_message_updates_existing_code`.
- [x] Waiting-for-code polling exists.
  - Evidence: `verification_poll_temp_mailbox` command and UI polling every 5 seconds; `wait_for_code_polling_reports_detected_code`.
- [x] Copy-code UI exists.
  - Evidence: `src/App.tsx` recent-code panel and `copyCode`; `npm run build` under full verification.
- [x] Source traceability from code to original message exists.
  - Evidence: `RecentVerificationCodeRow` includes `message_id`, `temp_mailbox_id`, `source_id`; UI shows original message id.

## Notes

Phase 4 is complete. Verification evidence:

- Red tests were observed for extractor, redaction, repository, service, and command DTO work before implementation.
- Targeted tests passed after implementation:
  - `extracts_common_6_digit_verification_code`
  - `extracts_code_from_subject_or_body`
  - `verification_code_not_logged_plain_by_default`
  - `associates_code_with_temp_mailbox_received_address`
  - `recent_codes_can_filter_by_temp_mailbox`
  - `refresh_temp_mailbox_extracts_codes_for_inserted_messages`
  - `reclassify_message_updates_existing_code`
  - `wait_for_code_polling_reports_detected_code`
  - `verification_code_row_maps_to_command_dto`
  - `verification_poll_result_maps_to_command_dto`
- Full verification: `npm run verify` passed with 46 Rust tests; `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

Do not log full verification codes by default; `verification_code_not_logged_plain_by_default` covers this.
