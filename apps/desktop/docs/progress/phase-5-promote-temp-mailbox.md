# Phase 5: Promote temporary mailbox

Source spec section: Milestone 5.

## Tasks

- [x] `temp_upgrade_mailbox` command exists.
  - Evidence: `temp_upgrade_mailbox` in `src-tauri/src/commands.rs`; `temp_upgrade_returns_account_and_mailbox_dtos`.
- [x] `normal_upgraded_temp` account creation is exposed through command/UI.
  - Evidence: `promote_temp_mailbox` service; `account_list_normal` command; `upgrade_temp_mailbox_creates_normal_upgraded_temp_account`; promoted account panel in `src/App.tsx`.
- [x] Promotion confirmation UI exists.
  - Evidence: `promoteMailbox` uses `window.confirm` and sends `confirm_lifecycle_ack`; `temp_upgrade_requires_confirmation_ack`.
- [x] Promoted account page exists.
  - Evidence: promoted account panel and history view in `src/App.tsx`; `npm run build` under full verification.
- [x] Anonymous query excludes promoted temp mailbox messages.
  - Evidence: `list_anonymous_messages` filters `temp_mailboxes.visibility_state = 'anonymous'`; existing `anonymous_message_query_excludes_upgraded_temp_mailbox`.
- [x] Promoted account historical message query exists without moving/copying messages.
  - Evidence: `list_promoted_account_messages`; `upgrade_does_not_move_or_rewrite_messages`; `upgraded_account_query_includes_historical_messages`.
- [x] Expired temp mailbox promotion displays history-only or degraded state.
  - Evidence: `expired_temp_upgrade_results_in_history_only_account`; UI warning for expired/history-only promoted accounts.

## Notes

Phase 5 is complete. Verification evidence:

- Red tests were observed for repository promotion invariants and service/command DTO work before implementation.
- Targeted tests passed after implementation:
  - `upgrade_temp_mailbox_creates_normal_upgraded_temp_account`
  - `upgrade_does_not_move_or_rewrite_messages`
  - `upgraded_account_query_includes_historical_messages`
  - `expired_temp_upgrade_results_in_history_only_account`
  - `temp_upgrade_requires_confirmation_ack`
  - `temp_upgrade_returns_account_and_mailbox_dtos`
- Full verification: `npm run verify` passed with 52 Rust tests; `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
