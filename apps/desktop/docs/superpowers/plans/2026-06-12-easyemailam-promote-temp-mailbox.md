# Promote Temporary Mailbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` / `- [x]`) syntax for tracking.

**Goal:** Build Milestone 5 from the approved EasyEmailAM spec: promote anonymous temporary mailboxes into visible normal accounts without moving/copying historical messages, and expose the product workflow in commands and UI.

**Architecture:** Keep promotion as a local management transition. The repository transaction creates a `normal_upgraded_temp` account and updates temp/source bindings; services validate confirmation and lifecycle truth; message queries keep history tied to the original temp mailbox/source rows. Commands stay DTO-only and React owns the explicit confirmation UX.

**Tech Stack:** Rust 2021, rusqlite, serde/serde_json, Tauri 2 commands, React 19, TypeScript, Vite.

---

## File structure

- Modify `src-tauri/src/storage/account_repository.rs`
  - Expand `AccountRow` to include provider/status/auth/receive/send fields needed by UI.
  - Keep `list_normal_accounts` including `normal_upgraded_temp`.
- Modify `src-tauri/src/storage/temp_mailbox_repository.rs`
  - Harden `upgrade_temp_mailbox` to update source/message source account bindings without changing message ids.
  - Preserve history-only account state for expired/history-only temp mailboxes.
- Modify `src-tauri/src/storage/message_repository.rs`
  - Add promoted-account historical message query.
- Create `src-tauri/src/services/temp_mailbox_service.rs`
  - Add promotion service with explicit lifecycle confirmation.
  - Return promoted account + updated mailbox rows.
- Modify `src-tauri/src/services/mod.rs`
  - Export `temp_mailbox_service`.
- Modify `src-tauri/src/commands.rs`
  - Add `account_list_normal`.
  - Add `temp_upgrade_mailbox`.
  - Extend `message_list` to support `scope="promoted_account"` with `account_id`.
- Modify `src-tauri/src/lib.rs`
  - Register new commands.
- Modify `src/App.tsx`
  - Add normal/promoted account panel.
  - Add promotion confirmation action on anonymous temp mailboxes.
  - Add promoted account detail/history view.
  - Show expired/history-only warning truthfully.
- Modify `src/App.css`
  - Style account list, promotion action, promoted history, lifecycle warning.
- Modify closeout docs:
  - `docs/progress/MASTER.md`
  - `docs/progress/phase-5-promote-temp-mailbox.md`
  - this plan file

---

## Task 1: Repository promotion invariants and historical query

**Files:**
- Modify: `src-tauri/src/storage/account_repository.rs`
- Modify: `src-tauri/src/storage/temp_mailbox_repository.rs`
- Modify: `src-tauri/src/storage/message_repository.rs`

- [x] **Step 1: Write failing repository tests**

Add/adjust tests:

```rust
#[test]
fn upgrade_temp_mailbox_creates_normal_upgraded_temp_account() {
    let mut connection = test_connection();
    let mailbox = seed_temp_with_message(&connection, "temp_1", "code@example.test", "observed_1");

    let account_id = upgrade_temp_mailbox(
        &mut connection,
        &mailbox.id,
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("upgrade temp");

    let account = list_normal_accounts(&connection)
        .expect("list accounts")
        .into_iter()
        .find(|row| row.id == account_id)
        .expect("promoted account visible");
    assert_eq!(account.kind, "normal_upgraded_temp");
    assert_eq!(account.primary_address, Some("code@example.test".to_string()));
    assert_eq!(account.status, "ready");
}

#[test]
fn upgrade_does_not_move_or_rewrite_messages() {
    let mut connection = test_connection();
    let mailbox = seed_temp_with_message(&connection, "temp_1", "code@example.test", "observed_1");
    let before_message_ids = all_message_ids(&connection);
    let before_source_ids = all_message_source_ids(&connection);

    upgrade_temp_mailbox(
        &mut connection,
        &mailbox.id,
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("upgrade temp");

    assert_eq!(all_message_ids(&connection), before_message_ids);
    assert_eq!(all_message_source_ids(&connection), before_source_ids);
}

#[test]
fn upgraded_account_query_includes_historical_messages() {
    let mut connection = test_connection();
    let mailbox = seed_temp_with_message(&connection, "temp_1", "code@example.test", "observed_1");
    let account_id = upgrade_temp_mailbox(
        &mut connection,
        &mailbox.id,
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("upgrade temp");

    let rows = list_promoted_account_messages(&connection, &account_id)
        .expect("list promoted history");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].message_id, "msg_temp_1");
    assert_eq!(rows[0].received_address, "code@example.test");
    assert_eq!(rows[0].account_id, account_id);
}

#[test]
fn expired_temp_upgrade_results_in_history_only_account() {
    let mut connection = test_connection();
    let mailbox = seed_temp_with_message(&connection, "temp_1", "expired@example.test", "observed_1");
    connection
        .execute(
            "UPDATE temp_mailboxes SET lifecycle_state = 'expired' WHERE id = ?1",
            rusqlite::params![mailbox.id],
        )
        .expect("expire mailbox");

    let account_id = upgrade_temp_mailbox(
        &mut connection,
        &mailbox.id,
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("upgrade expired temp");

    let status: String = connection
        .query_row("SELECT status FROM accounts WHERE id = ?1", rusqlite::params![account_id], |row| row.get(0))
        .expect("account status");
    assert_eq!(status, "history_only");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml upgrade_temp_mailbox_creates_normal_upgraded_temp_account
cargo test --manifest-path src-tauri/Cargo.toml upgrade_does_not_move_or_rewrite_messages
cargo test --manifest-path src-tauri/Cargo.toml upgraded_account_query_includes_historical_messages
cargo test --manifest-path src-tauri/Cargo.toml expired_temp_upgrade_results_in_history_only_account
```

Expected before implementation: tests fail because account rows lack status fields, promoted-account message query does not exist, and account/source binding is incomplete.

- [x] **Step 3: Implement repository changes**

Implement:

- `AccountRow` fields: `provider_label`, `status`, `auth_status`, `receive_status`, `send_status`.
- `upgrade_temp_mailbox` updates:
  - `temp_mailboxes.visibility_state = 'upgraded'`
  - `temp_mailboxes.upgraded_account_id = account_id`
  - `mailbox_sources.account_id = account_id` when `source_id` exists.
  - `message_sources.account_id = account_id` for the temp mailbox.
- `PromotedAccountMessageRow`.
- `list_promoted_account_messages(connection, account_id)`.

- [x] **Step 4: Run repository tests**

Run the four tests from Step 2. Expected: all pass.

- [x] **Step 5: Commit repository work**

Run:

```powershell
git add src-tauri/src/storage/account_repository.rs src-tauri/src/storage/temp_mailbox_repository.rs src-tauri/src/storage/message_repository.rs
git commit -m "feat: preserve temp mailbox history on promotion"
```

---

## Task 2: Promotion service and commands

**Files:**
- Create: `src-tauri/src/services/temp_mailbox_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing service/command tests**

Add tests:

```rust
#[test]
fn temp_upgrade_requires_confirmation_ack() {
    let mut connection = test_connection();
    let mailbox = seed_temp_mailbox(&connection, "confirm@example.test");

    let error = promote_temp_mailbox(
        &mut connection,
        PromoteTempMailboxRequest {
            temp_mailbox_id: mailbox.id,
            confirm_lifecycle_ack: false,
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect_err("confirmation required");

    assert_eq!(error.code, "temp_upgrade_confirmation_required");
}

#[test]
fn temp_upgrade_returns_account_and_mailbox_dtos() {
    let account = account_row_for_test();
    let mailbox = temp_mailbox_row_for_test();
    let result = PromoteTempMailboxResult { account, mailbox };

    let dto = promote_result_to_dto(result);

    assert_eq!(dto.account.kind, "normal_upgraded_temp");
    assert_eq!(dto.mailbox.visibility_state, "upgraded");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml temp_upgrade_requires_confirmation_ack
cargo test --manifest-path src-tauri/Cargo.toml temp_upgrade_returns_account_and_mailbox_dtos
```

Expected before implementation: tests fail because service and command DTOs do not exist.

- [x] **Step 3: Implement service and commands**

Add:

- `PromoteTempMailboxRequest { temp_mailbox_id, confirm_lifecycle_ack }`.
- `PromoteTempMailboxResult { account: AccountRow, mailbox: TempMailboxRow }`.
- `promote_temp_mailbox(&mut Connection, request, now)`.
- Commands:
  - `account_list_normal`
  - `temp_upgrade_mailbox`
  - `message_list` supports `scope="promoted_account"` and required `account_id`.

- [x] **Step 4: Verify service/command tests and compile**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml temp_upgrade_requires_confirmation_ack
cargo test --manifest-path src-tauri/Cargo.toml temp_upgrade_returns_account_and_mailbox_dtos
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: tests and check pass.

- [x] **Step 5: Commit service/commands**

Run:

```powershell
git add src-tauri/src/services/mod.rs src-tauri/src/services/temp_mailbox_service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: expose temp mailbox promotion"
```

---

## Task 3: Promotion UI and promoted history view

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Implement UI state and command calls**

Add DTOs:

- `AccountDto`
- `PromoteTempMailboxDto`

Add state:

- `normalAccounts`
- `selectedPromotedAccountId`
- `promotedMessages`
- `lastPromotion`

Add helpers:

- `loadNormalAccounts`
- `loadPromotedMessages(accountId)`
- `promoteMailbox(mailbox)`

- [x] **Step 2: Add confirmation and promoted account panels**

UI requirements:

- Anonymous temp mailbox rows show a `Promote` action only when `visibility_state === "anonymous"`.
- Promotion uses `window.confirm` and explains that promotion does not extend provider lifetime or move messages.
- Expired/history-only mailboxes show a warning before promotion and in the promoted account panel.
- Normal/promoted account panel lists visible normal accounts.
- Selecting a promoted account loads historical messages by original `message_id`.
- Anonymous message list no longer shows upgraded mailbox mail after promotion because existing anonymous query filters `visibility_state = 'anonymous'`.

- [x] **Step 3: Verify UI compile**

Run:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both pass.

- [x] **Step 4: Commit UI**

Run:

```powershell
git add src/App.tsx src/App.css
git commit -m "feat: add temp mailbox promotion UI"
```

---

## Task 4: Full verification and tracker closeout

**Files:**
- Modify: `docs/progress/MASTER.md`
- Modify: `docs/progress/phase-5-promote-temp-mailbox.md`
- Modify: `docs/superpowers/plans/2026-06-12-easyemailam-promote-temp-mailbox.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected:

```text
npm run build passes
cargo fmt passes
cargo test passes
cargo check passes
cargo clippy exits 0 with -D warnings
```

- [x] **Step 2: Update progress trackers**

Update:

- `docs/progress/phase-5-promote-temp-mailbox.md`: mark all Phase 5 tasks complete with evidence.
- `docs/progress/MASTER.md`: Phase 5 becomes 7/7, overall progress becomes 43/68, active phase becomes Phase 6.

- [x] **Step 3: Mark this plan complete**

Change all plan checkboxes to `- [x]` after evidence exists and append an execution record containing red/green/full verification evidence and commits.

- [x] **Step 4: Commit closeout**

Run:

```powershell
git add docs/progress docs/superpowers/plans/2026-06-12-easyemailam-promote-temp-mailbox.md
git commit -m "docs: mark promotion phase executed"
git status --short --branch
```

---

## Execution record

Plan execution status: complete.

### Red evidence observed before implementation

- Repository tests failed before `AccountRow.status` and `list_promoted_account_messages` existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml upgrade_temp_mailbox_creates_normal_upgraded_temp_account`
  - `cargo test --manifest-path src-tauri/Cargo.toml upgrade_does_not_move_or_rewrite_messages`
  - `cargo test --manifest-path src-tauri/Cargo.toml upgraded_account_query_includes_historical_messages`
  - `cargo test --manifest-path src-tauri/Cargo.toml expired_temp_upgrade_results_in_history_only_account`
- Service/command tests failed before `PromoteTempMailboxRequest`, `PromoteTempMailboxResult`, `promote_temp_mailbox`, and `promote_result_to_dto` existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml temp_upgrade_requires_confirmation_ack`
  - `cargo test --manifest-path src-tauri/Cargo.toml temp_upgrade_returns_account_and_mailbox_dtos`

### Targeted green evidence

The targeted tests above passed after implementation:

- `upgrade_temp_mailbox_creates_normal_upgraded_temp_account`
- `upgrade_does_not_move_or_rewrite_messages`
- `upgraded_account_query_includes_historical_messages`
- `expired_temp_upgrade_results_in_history_only_account`
- `temp_upgrade_requires_confirmation_ack`
- `temp_upgrade_returns_account_and_mailbox_dtos`

### Full verification evidence

- `npm run verify` passed:
  - `npm run build` passed.
  - `cargo fmt` passed.
  - `cargo test` passed with 52 tests.
  - `cargo check` passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

### Commits

- `acb1080 docs: plan promotion phase`
- `d849dab feat: preserve temp mailbox history on promotion`
- `41f0023 feat: expose temp mailbox promotion`
- `6a23e55 feat: add temp mailbox promotion UI`
- `bc4a746 style: apply rustfmt after promotion phase`

### Remaining phases

- Phase 0 still has EventBus and logging skeleton gaps.
- Phase 6 remains: normal IMAP basics.
- Phase 7 remains: SMTP and send queue.
- Phase 8 remains: Agent mailbox MVP.
