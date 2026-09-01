# Normal IMAP Basics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` / `- [x]`) syntax for tracking.

**Goal:** Build Milestone 6 from the approved EasyEmailAM spec: add manual normal IMAP accounts with credential references only, fake/real adapter boundaries, connection testing, bounded initial sync, and normal mailbox message list/detail UI.

**Architecture:** Separate secret storage, adapter behavior, account creation, sync, and command/UI boundaries. SQLite stores only `credential_refs` and source/account/message metadata; password material goes only through `SecretVaultAdapter`. Version 1 uses a fake IMAP adapter in tests and a real-adapter skeleton that reports unsupported until a concrete IMAP dependency is intentionally added.

**Tech Stack:** Rust 2021, rusqlite, serde/serde_json, Tauri 2 commands, React 19, TypeScript, Vite.

---

## File structure

- Modify `src-tauri/migrations/0001_foundation.sql`
  - Add `mail_folders` table needed by bounded folder sync.
- Create `src-tauri/src/secret/mod.rs`, `fake.rs`, `windows.rs`
  - Define `SecretVaultAdapter`.
  - Implement `FakeSecretVaultAdapter`.
  - Add `WindowsCredentialManagerVault` skeleton.
- Create `src-tauri/src/imap/mod.rs`, `adapter.rs`, `fake.rs`, `native.rs`, `models.rs`
  - Define `ImapAdapter`.
  - Implement fake adapter for tests.
  - Add native/real skeleton returning unsupported errors.
- Create `src-tauri/src/storage/credential_repository.rs`
  - Insert/list credential refs without secret values.
- Create `src-tauri/src/storage/mail_folder_repository.rs`
  - Persist discovered IMAP folders.
- Modify `src-tauri/src/storage/account_repository.rs`
  - Add helper to create/list normal long-lived accounts and source linkage where needed.
- Modify `src-tauri/src/storage/message_repository.rs`
  - Add normal account message list/detail queries.
  - Keep detail DTO free of credential metadata.
- Create `src-tauri/src/services/normal_account_service.rs`
  - Manual IMAP add.
  - IMAP connection test.
  - Initial bounded recent-header sync.
  - Auth failure status handling.
- Modify `src-tauri/src/services/mod.rs`
  - Export normal account service.
- Modify `src-tauri/src/commands.rs`
  - Add:
    - `normal_account_test_imap`
    - `normal_account_add_manual_imap`
    - `normal_account_sync_recent`
    - `message_get_detail`
  - Extend `message_list` with `scope="normal_account"`.
- Modify `src-tauri/src/lib.rs`
  - Register new commands/modules.
- Modify `src/App.tsx` and `src/App.css`
  - Add manual IMAP form.
  - Add account status display.
  - Add normal account message list/detail panel.

---

## Task 1: Secret vault and credential-reference repository

**Files:**
- Create: `src-tauri/src/secret/mod.rs`
- Create: `src-tauri/src/secret/fake.rs`
- Create: `src-tauri/src/secret/windows.rs`
- Create: `src-tauri/src/storage/credential_repository.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing tests**

Add tests:

```rust
#[test]
fn fake_secret_vault_round_trips_without_sqlite() {
    let vault = FakeSecretVaultAdapter::default();

    vault.save_secret("secret://imap/account-1", "app-password").expect("save");

    assert!(vault.exists("secret://imap/account-1").expect("exists"));
    assert_eq!(
        vault.load_secret("secret://imap/account-1").expect("load"),
        Some("app-password".to_string())
    );
}

#[test]
fn credential_ref_repository_never_stores_secret_value() {
    let connection = test_connection();

    let row = insert_credential_ref(
        &connection,
        NewCredentialRef {
            owner_account_id: "acct_1".to_string(),
            source_id: "src_1".to_string(),
            secret_backend: "fake_vault".to_string(),
            secret_key: "secret://imap/account-1".to_string(),
            credential_kind: "imap_password".to_string(),
            auth_method: "password".to_string(),
            now: "2026-06-12T00:00:00Z".to_string(),
        },
    )
    .expect("insert credential ref");

    let serialized = serde_json::to_string(&row).expect("serialize row");
    assert!(serialized.contains("secret://imap/account-1"));
    assert!(!serialized.contains("app-password"));
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml fake_secret_vault_round_trips_without_sqlite
cargo test --manifest-path src-tauri/Cargo.toml credential_ref_repository_never_stores_secret_value
```

Expected before implementation: tests fail because secret and credential repository modules do not exist.

- [x] **Step 3: Implement secret and credential boundaries**

Implement:

- `SecretVaultAdapter` trait: `save_secret`, `load_secret`, `delete_secret`, `exists`.
- `FakeSecretVaultAdapter` using `Arc<Mutex<HashMap<String, String>>>`.
- `WindowsCredentialManagerVault` skeleton with the same trait and explicit unsupported error until native credential-manager binding is added.
- `CredentialRefRow`, `NewCredentialRef`, `insert_credential_ref`, `get_credential_ref`.

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: both pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/secret src-tauri/src/storage/credential_repository.rs src-tauri/src/storage/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add secret vault boundary"
```

---

## Task 2: IMAP adapter skeleton and connection test

**Files:**
- Create: `src-tauri/src/imap/mod.rs`
- Create: `src-tauri/src/imap/adapter.rs`
- Create: `src-tauri/src/imap/models.rs`
- Create: `src-tauri/src/imap/fake.rs`
- Create: `src-tauri/src/imap/native.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing tests**

Add tests:

```rust
#[test]
fn fake_imap_adapter_tests_connection_success() {
    let adapter = FakeImapAdapter::with_connection_success();
    let profile = ImapConnectionProfile {
        host: "imap.example.test".to_string(),
        port: 993,
        security: "tls".to_string(),
        username: "user@example.test".to_string(),
    };

    let result = adapter.test_connection(&profile, "app-password").expect("test connection");

    assert!(result.authenticated);
    assert_eq!(result.capability_summary, "fake-imap-ready");
}

#[test]
fn native_imap_adapter_reports_unsupported_until_dependency_exists() {
    let adapter = NativeImapAdapter::default();
    let profile = ImapConnectionProfile {
        host: "imap.example.test".to_string(),
        port: 993,
        security: "tls".to_string(),
        username: "user@example.test".to_string(),
    };

    let error = adapter
        .test_connection(&profile, "app-password")
        .expect_err("native skeleton unsupported");
    assert_eq!(error.code, "imap_native_adapter_unavailable");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml fake_imap_adapter_tests_connection_success
cargo test --manifest-path src-tauri/Cargo.toml native_imap_adapter_reports_unsupported_until_dependency_exists
```

Expected before implementation: IMAP modules do not exist.

- [x] **Step 3: Implement adapter boundary**

Implement trait methods:

- `test_connection`
- `discover_folders`
- `fetch_recent_headers`
- `fetch_incremental`
- `fetch_message_body`

Fake adapter stores configured folders/messages. Native adapter returns unsupported `AppError`.

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: both pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/imap src-tauri/src/lib.rs
git commit -m "feat: add imap adapter boundary"
```

---

## Task 3: Manual IMAP account creation and initial sync

**Files:**
- Modify: `src-tauri/migrations/0001_foundation.sql`
- Create: `src-tauri/src/storage/mail_folder_repository.rs`
- Modify: `src-tauri/src/storage/message_repository.rs`
- Create: `src-tauri/src/services/normal_account_service.rs`
- Modify: `src-tauri/src/services/mod.rs`

- [x] **Step 1: Write failing service tests**

Add tests:

```rust
#[test]
fn manual_account_create_saves_credential_ref_not_secret() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_connection_success();

    let result = add_manual_imap_account(
        &connection,
        &vault,
        &adapter,
        ManualImapAccountRequest {
            display_name: "Work".to_string(),
            email_address: "work@example.test".to_string(),
            imap_host: "imap.example.test".to_string(),
            imap_port: 993,
            imap_security: "tls".to_string(),
            imap_username: "work@example.test".to_string(),
            imap_password: "app-password".to_string(),
        },
        "2026-06-12T00:00:00Z".to_string(),
    )
    .expect("add manual imap");

    assert_eq!(result.account.kind, "normal_long_lived");
    assert!(vault.exists(&result.credential.secret_key).expect("secret exists"));
    assert_no_sqlite_value_contains(&connection, "app-password");
}

#[test]
fn normal_account_initial_sync_saves_messages() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
    let result = seed_manual_account(&connection, &vault, &adapter);

    let sync = sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");

    assert_eq!(sync.inserted_count, 1);
    assert_eq!(list_normal_account_messages(&connection, &result.account.id).expect("messages").len(), 1);
}

#[test]
fn imap_auth_failure_sets_auth_failed_status() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::auth_failed();

    let error = add_manual_imap_account(
        &connection,
        &vault,
        &adapter,
        ManualImapAccountRequest {
            display_name: "Work".to_string(),
            email_address: "work@example.test".to_string(),
            imap_host: "imap.example.test".to_string(),
            imap_port: 993,
            imap_security: "tls".to_string(),
            imap_username: "work@example.test".to_string(),
            imap_password: "bad-password".to_string(),
        },
        "2026-06-12T00:00:00Z".to_string(),
    )
    .expect_err("auth failure");

    assert_eq!(error.code, "imap_auth_failed");
    assert_no_normal_account_created(&connection);
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml manual_account_create_saves_credential_ref_not_secret
cargo test --manifest-path src-tauri/Cargo.toml normal_account_initial_sync_saves_messages
cargo test --manifest-path src-tauri/Cargo.toml imap_auth_failure_sets_auth_failed_status
```

Expected before implementation: service/storage functions do not exist.

- [x] **Step 3: Implement account add and bounded sync**

Implement:

- `mail_folders` migration/table.
- `MailFolderRow`, `insert_mail_folder`.
- `ManualImapAccountRequest`.
- `add_manual_imap_account`.
- `sync_recent_headers` with idempotent message/source persistence.
- `list_normal_account_messages`.

Rules:

- No plaintext secret in SQLite.
- Authentication failure returns validation/auth error and does not create partial account records.
- Initial sync is bounded by request limit.

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: all pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/migrations/0001_foundation.sql src-tauri/src/storage/mail_folder_repository.rs src-tauri/src/storage/message_repository.rs src-tauri/src/services/normal_account_service.rs src-tauri/src/services/mod.rs
git commit -m "feat: add manual imap account sync"
```

---

## Task 4: Commands and UI for normal IMAP basics

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Write failing command tests**

Add tests:

```rust
#[test]
fn normal_message_detail_does_not_expose_secret_metadata() {
    let detail = NormalMessageDetailRow {
        message_id: "msg_1".to_string(),
        account_id: "acct_1".to_string(),
        subject: "Welcome".to_string(),
        from_address: "noreply@example.test".to_string(),
        body_text: Some("Hello".to_string()),
        credential_ref_id: Some("cred_1".to_string()),
        secret_key: Some("secret://imap/account-1".to_string()),
    };

    let dto = normal_message_detail_to_dto(detail);
    let serialized = serde_json::to_string(&dto).expect("serialize dto");

    assert!(!serialized.contains("secret://imap/account-1"));
    assert!(!serialized.contains("credential_ref_id"));
}
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml normal_message_detail_does_not_expose_secret_metadata
```

Expected before implementation: detail DTO/helper does not exist.

- [x] **Step 3: Implement commands and UI**

Commands:

- `normal_account_test_imap`
- `normal_account_add_manual_imap`
- `normal_account_sync_recent`
- `message_get_detail`
- `message_list scope="normal_account"`

UI:

- Manual IMAP form.
- Connection test button.
- Add account button.
- Sync recent button.
- Normal account status cards.
- Message list/detail panel.

- [x] **Step 4: Verify UI/backend compile**

Run:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/App.tsx src/App.css
git commit -m "feat: add normal imap account UI"
```

---

## Task 5: Full verification and tracker closeout

**Files:**
- Modify: `docs/progress/MASTER.md`
- Modify: `docs/progress/phase-6-normal-imap.md`
- Modify: `docs/superpowers/plans/2026-06-12-easyemailam-normal-imap-basics.md`

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

- `docs/progress/phase-6-normal-imap.md`: mark all Phase 6 tasks complete with evidence.
- `docs/progress/MASTER.md`: Phase 6 becomes 7/7, overall progress becomes 50/68, active phase becomes Phase 7.

- [x] **Step 3: Mark this plan complete**

Change all plan checkboxes to `- [x]` after evidence exists and append an execution record containing red/green/full verification evidence and commits.

- [x] **Step 4: Commit closeout**

Run:

```powershell
git add docs/progress docs/superpowers/plans/2026-06-12-easyemailam-normal-imap-basics.md
git commit -m "docs: mark normal imap phase executed"
git status --short --branch
```

---

## Execution record

Completed on branch `foundation`.

### Red evidence

- Task 1 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml fake_secret_vault_round_trips_without_sqlite`
  - `cargo test --manifest-path src-tauri/Cargo.toml credential_ref_repository_never_stores_secret_value`
  - Expected failure: secret/credential repository modules and APIs did not exist.
- Task 2 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml fake_imap_adapter_tests_connection_success`
  - `cargo test --manifest-path src-tauri/Cargo.toml native_imap_adapter_reports_unsupported_until_dependency_exists`
  - Expected failure: IMAP adapter modules and APIs did not exist.
- Task 3 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml manual_account_create_saves_credential_ref_not_secret`
  - `cargo test --manifest-path src-tauri/Cargo.toml normal_account_initial_sync_saves_messages`
  - `cargo test --manifest-path src-tauri/Cargo.toml imap_auth_failure_sets_auth_failed_status`
  - Expected failure: `list_normal_account_messages`, `ManualImapAccountRequest`, `SyncRecentHeadersRequest`, `AddManualImapAccountResult`, `add_manual_imap_account`, `sync_recent_headers`, and test helpers were missing.
- Task 4 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml normal_message_detail_does_not_expose_secret_metadata`
  - Expected failure: `NormalMessageDetailRow` and `normal_message_detail_to_dto` were missing.

### Green evidence

- Task 1 green:
  - `cargo test --manifest-path src-tauri/Cargo.toml fake_secret_vault_round_trips_without_sqlite`
  - `cargo test --manifest-path src-tauri/Cargo.toml credential_ref_repository_never_stores_secret_value`
  - Commit: `645cdad feat: add secret vault boundary`.
- Task 2 green:
  - `cargo fmt --manifest-path src-tauri/Cargo.toml`
  - `cargo test --manifest-path src-tauri/Cargo.toml fake_imap_adapter_tests_connection_success`
  - `cargo test --manifest-path src-tauri/Cargo.toml native_imap_adapter_reports_unsupported_until_dependency_exists`
  - Commit: `fe899bd feat: add imap adapter boundary`.
- Task 3 green:
  - `cargo fmt --manifest-path src-tauri/Cargo.toml`
  - `cargo test --manifest-path src-tauri/Cargo.toml manual_account_create_saves_credential_ref_not_secret`
  - `cargo test --manifest-path src-tauri/Cargo.toml normal_account_initial_sync_saves_messages`
  - `cargo test --manifest-path src-tauri/Cargo.toml imap_auth_failure_sets_auth_failed_status`
  - `cargo test --manifest-path src-tauri/Cargo.toml migrations_apply_cleanly`
  - Commit: `e48b297 feat: add manual imap account sync`.
- Task 4 green:
  - `cargo test --manifest-path src-tauri/Cargo.toml normal_message_detail_does_not_expose_secret_metadata`
  - `npm run build`
  - `cargo check --manifest-path src-tauri/Cargo.toml`
  - Commit: `85fbfa7 feat: add normal imap account UI`.

### Full verification

- `npm run verify` passed.
  - `npm run build`: TypeScript and Vite production build passed.
  - `npm run rust:fmt`: `cargo fmt --manifest-path src-tauri/Cargo.toml` passed.
  - `npm run rust:test`: `cargo test --manifest-path src-tauri/Cargo.toml` passed with 61 tests.
  - `npm run rust:check`: `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

### Tracker updates

- `docs/progress/phase-6-normal-imap.md`: 7/7 tasks checked with evidence.
- `docs/progress/MASTER.md`: Phase 6 marked complete, overall progress updated to 50/68, active phase moved to Phase 7.
