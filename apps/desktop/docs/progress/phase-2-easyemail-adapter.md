# Phase 2: EasyEmail adapter and temporary mailbox creation

Source spec section: Milestone 2.

## Tasks

- [x] `EasyEmailAdapter` trait exists.
- [x] HTTP adapter exists for `/mail/catalog` and `/mail/mailboxes/open`.
- [x] Fake adapter exists for offline tests.
- [x] `settings_test_easyemail` command exists.
- [x] `temp_create_mailbox` command exists.
- [x] `temp_list_mailboxes` command exists.
- [x] Basic temp mailbox UI exists.

## Evidence

- Plan: `../superpowers/plans/2026-06-12-easyemailam-easyemail-adapter.md`
- Final verification recorded in that plan:
  - `npm run verify`: 26 tests passed at phase closeout.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: exit 0.

## Notes

API tokens are accepted only as one-shot command inputs and are not persisted in SQLite.
