# SMTP Send Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Milestone 7 from the approved EasyEmailAM spec: SMTP adapter boundary, persisted `send_queue`, non-blocking draft/send commands, a one-shot SendQueueWorker, retry/backoff, and send-status UI.

**Architecture:** Sending is always a two-step workflow: commands validate sender capability and enqueue a local outgoing message; the SendQueueWorker later claims queued work and calls `SmtpAdapter`. SQLite stores queue/account/source/message metadata and credential references only; SMTP passwords stay behind `SecretVaultAdapter`. Version 1 includes a fake SMTP adapter for tests and a native skeleton returning explicit unsupported errors until real SMTP wiring is added.

**Tech Stack:** Rust 2021, rusqlite, serde/serde_json, Tauri 2 commands, React 19, TypeScript, Vite.

---

## File structure

- Modify `src-tauri/migrations/0001_foundation.sql`
  - Add `send_queue` table and indexes for queued/due work.
- Modify `src-tauri/src/domain/account.rs`
  - Add constructor/helper for send-enabled normal test accounts only if needed by repository tests.
- Create `src-tauri/src/smtp/mod.rs`, `adapter.rs`, `fake.rs`, `native.rs`, `models.rs`
  - Define `SmtpAdapter`.
  - Implement fake adapter for tests.
  - Add native/real skeleton returning unsupported errors.
- Create `src-tauri/src/storage/send_queue_repository.rs`
  - Enqueue send jobs.
  - List recent send queue items.
  - Claim one due queued/retry item.
  - Mark sending/sent/retry/auth-failed/permanent-failed.
- Modify `src-tauri/src/storage/account_repository.rs`
  - Add helper to load a send-capable SMTP source for an account.
- Modify `src-tauri/src/storage/message_repository.rs`
  - Add outgoing message persistence for send drafts.
- Modify `src-tauri/src/storage/mod.rs`
  - Export `send_queue_repository`.
- Create `src-tauri/src/services/send_service.rs`
  - Validate sender account send capability.
  - Enqueue outgoing messages without calling SMTP.
- Create `src-tauri/src/workers/mod.rs`
- Create `src-tauri/src/workers/send_queue_worker.rs`
  - One-shot worker that processes at most one due queue item.
- Modify `src-tauri/src/services/mod.rs`
  - Export send service.
- Modify `src-tauri/src/lib.rs`
  - Register `smtp` and `workers` modules and Tauri commands.
- Modify `src-tauri/src/commands.rs`
  - Add:
    - `send_message`
    - `send_queue_list`
    - `send_queue_run_once`
- Modify `src/App.tsx` and `src/App.css`
  - Add compose form.
  - Add send queue/status panel.
  - Add manual worker-run button.

---

## Task 1: SMTP adapter boundary

**Files:**
- Create: `src-tauri/src/smtp/mod.rs`
- Create: `src-tauri/src/smtp/adapter.rs`
- Create: `src-tauri/src/smtp/models.rs`
- Create: `src-tauri/src/smtp/fake.rs`
- Create: `src-tauri/src/smtp/native.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing tests**

Add tests:

```rust
#[test]
fn fake_smtp_adapter_sends_message() {
    let adapter = FakeSmtpAdapter::success();
    let profile = SmtpConnectionProfile {
        host: "smtp.example.test".to_string(),
        port: 587,
        security: "starttls".to_string(),
        username: "sender@example.test".to_string(),
    };
    let message = SmtpSendMessage {
        from_address: "sender@example.test".to_string(),
        to_address: "target@example.test".to_string(),
        subject: "Hello".to_string(),
        body_text: "Queued body".to_string(),
    };

    let result = adapter
        .send_message(&profile, "app-password", &message)
        .expect("send message");

    assert_eq!(result.provider_message_id, Some("fake-smtp-message-id".to_string()));
    assert_eq!(adapter.sent_messages().len(), 1);
}

#[test]
fn native_smtp_adapter_reports_unsupported_until_dependency_exists() {
    let adapter = NativeSmtpAdapter;
    let profile = SmtpConnectionProfile {
        host: "smtp.example.test".to_string(),
        port: 587,
        security: "starttls".to_string(),
        username: "sender@example.test".to_string(),
    };

    let error = adapter
        .test_connection(&profile, "app-password")
        .expect_err("native skeleton unsupported");

    assert_eq!(error.code, "smtp_native_adapter_unavailable");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml fake_smtp_adapter_sends_message
cargo test --manifest-path src-tauri/Cargo.toml native_smtp_adapter_reports_unsupported_until_dependency_exists
```

Expected before implementation: SMTP modules and types do not exist.

- [x] **Step 3: Implement SMTP adapter boundary**

Implement:

- `SmtpConnectionProfile { host, port, security, username }`
- `SmtpConnectionTestResult { authenticated, capability_summary }`
- `SmtpSendMessage { from_address, to_address, subject, body_text }`
- `SmtpSendResult { provider_message_id }`
- `SmtpAdapter` trait:
  - `test_connection`
  - `send_message`
- `FakeSmtpAdapter` modes:
  - `success`
  - `retryable_failure`
  - `auth_failure`
  - `sent_messages`
- `NativeSmtpAdapter` skeleton returning `smtp_native_adapter_unavailable`.

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: both pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/smtp src-tauri/src/lib.rs
git commit -m "feat: add smtp adapter boundary"
```

---

## Task 2: Send queue schema and repository

**Files:**
- Modify: `src-tauri/migrations/0001_foundation.sql`
- Create: `src-tauri/src/storage/send_queue_repository.rs`
- Modify: `src-tauri/src/storage/mod.rs`

- [x] **Step 1: Write failing repository tests**

Add tests:

```rust
#[test]
fn send_queue_repository_enqueues_queued_job() {
    let connection = test_connection();
    seed_sendable_account_source_and_message(&connection);

    let row = enqueue_send(
        &connection,
        NewSendQueueItem {
            account_id: "acct_send".to_string(),
            source_id: "src_smtp".to_string(),
            message_id: "msg_outgoing".to_string(),
            target_address: "target@example.test".to_string(),
            now: "2026-06-12T01:00:00Z".to_string(),
        },
    )
    .expect("enqueue send");

    assert_eq!(row.status, "queued");
    assert_eq!(row.attempt_count, 0);
    assert_eq!(row.target_address, "target@example.test");
}

#[test]
fn claim_next_due_send_marks_job_sending_once() {
    let connection = test_connection();
    seed_sendable_account_source_and_message(&connection);
    enqueue_send(
        &connection,
        NewSendQueueItem {
            account_id: "acct_send".to_string(),
            source_id: "src_smtp".to_string(),
            message_id: "msg_outgoing".to_string(),
            target_address: "target@example.test".to_string(),
            now: "2026-06-12T01:00:00Z".to_string(),
        },
    )
    .expect("enqueue send");

    let first = claim_next_due_send(&connection, "2026-06-12T01:00:01Z")
        .expect("claim")
        .expect("job");
    let second = claim_next_due_send(&connection, "2026-06-12T01:00:02Z")
        .expect("claim again");

    assert_eq!(first.status, "sending");
    assert!(second.is_none());
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml send_queue_repository_enqueues_queued_job
cargo test --manifest-path src-tauri/Cargo.toml claim_next_due_send_marks_job_sending_once
```

Expected before implementation: `send_queue` table and repository APIs do not exist.

- [x] **Step 3: Implement repository**

Implement:

- `send_queue` table:
  - `id`, `account_id`, `source_id`, `message_id`, `target_address`, `status`, `attempt_count`, `next_retry_at`, `last_error_code`, `last_error_message`, `created_at`, `updated_at`, `sent_at`.
- Index:
  - `(status, next_retry_at, created_at)` for due work.
- `SendQueueRow`
- `NewSendQueueItem`
- `enqueue_send`
- `list_recent_send_queue`
- `claim_next_due_send`
- `mark_send_sent`
- `mark_send_retry`
- `mark_send_auth_failed`
- `mark_send_failed`

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: both pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/migrations/0001_foundation.sql src-tauri/src/storage/send_queue_repository.rs src-tauri/src/storage/mod.rs
git commit -m "feat: add send queue repository"
```

---

## Task 3: Send service validation and enqueue

**Files:**
- Modify: `src-tauri/src/storage/account_repository.rs`
- Modify: `src-tauri/src/storage/message_repository.rs`
- Create: `src-tauri/src/services/send_service.rs`
- Modify: `src-tauri/src/services/mod.rs`

- [x] **Step 1: Write failing service tests**

Add required tests:

```rust
#[test]
fn send_message_requires_send_enabled() {
    let connection = test_connection();
    seed_receive_only_normal_account(&connection);

    let error = enqueue_send_message(
        &connection,
        SendMessageRequest {
            account_id: "acct_receive_only".to_string(),
            target_address: "target@example.test".to_string(),
            subject: "Hello".to_string(),
            body_text: "Queued body".to_string(),
        },
        "2026-06-12T01:10:00Z".to_string(),
    )
    .expect_err("send disabled");

    assert_eq!(error.code, "send_not_enabled");
}

#[test]
fn anonymous_account_cannot_send() {
    let connection = test_connection();
    ensure_anonymous_virtual_account(&connection, "2026-06-12T01:10:00Z".to_string())
        .expect("anonymous");

    let error = enqueue_send_message(
        &connection,
        SendMessageRequest {
            account_id: "acct_anonymous_virtual".to_string(),
            target_address: "target@example.test".to_string(),
            subject: "Hello".to_string(),
            body_text: "Queued body".to_string(),
        },
        "2026-06-12T01:10:00Z".to_string(),
    )
    .expect_err("anonymous blocked");

    assert_eq!(error.code, "anonymous_account_cannot_send");
}

#[test]
fn send_message_enqueues_without_calling_smtp() {
    let connection = test_connection();
    seed_send_enabled_normal_account(&connection);

    let result = enqueue_send_message(
        &connection,
        SendMessageRequest {
            account_id: "acct_send".to_string(),
            target_address: "target@example.test".to_string(),
            subject: "Hello".to_string(),
            body_text: "Queued body".to_string(),
        },
        "2026-06-12T01:10:00Z".to_string(),
    )
    .expect("enqueue");

    assert_eq!(result.queue.status, "queued");
    assert_eq!(result.message.subject, "Hello");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml send_message_requires_send_enabled
cargo test --manifest-path src-tauri/Cargo.toml anonymous_account_cannot_send
cargo test --manifest-path src-tauri/Cargo.toml send_message_enqueues_without_calling_smtp
```

Expected before implementation: send service and outgoing message helpers do not exist.

- [x] **Step 3: Implement send service**

Implement:

- `get_send_capable_smtp_source_for_account`
  - Loads normal account with `send_status = 'enabled'`.
  - Loads `mailbox_sources.source_kind = 'smtp'`.
  - Loads credential ref secret key only as a reference.
- `insert_outgoing_message`
  - Inserts `messages` row with `classification = 'outgoing'` and cached body text.
  - Inserts `message_sources` row with `account_id` and SMTP source traceability.
- `SendMessageRequest`
- `SendMessageResult`
- `enqueue_send_message`
  - Rejects anonymous virtual account with `anonymous_account_cannot_send`.
  - Rejects missing/unsupported/disabled send status with `send_not_enabled`.
  - Enqueues but does not call SMTP.

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: all pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/storage/account_repository.rs src-tauri/src/storage/message_repository.rs src-tauri/src/services/send_service.rs src-tauri/src/services/mod.rs
git commit -m "feat: enqueue normal account sends"
```

---

## Task 4: SendQueueWorker retry/backoff and idempotency

**Files:**
- Create: `src-tauri/src/workers/mod.rs`
- Create: `src-tauri/src/workers/send_queue_worker.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing worker tests**

Add required tests:

```rust
#[test]
fn smtp_retryable_error_requeues_with_backoff() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send(&connection);
    let adapter = FakeSmtpAdapter::retryable_failure();

    let result = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("worker");

    assert_eq!(result.processed_count, 1);
    let rows = list_recent_send_queue(&connection, 10).expect("list queue");
    assert_eq!(rows[0].status, "queued");
    assert_eq!(rows[0].attempt_count, 1);
    assert_eq!(rows[0].next_retry_at, Some("2026-06-12T01:21:00Z".to_string()));
}

#[test]
fn smtp_auth_failure_sets_action_required() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send(&connection);
    let adapter = FakeSmtpAdapter::auth_failure();

    run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("worker");

    let rows = list_recent_send_queue(&connection, 10).expect("list queue");
    assert_eq!(rows[0].status, "auth_failed");
    assert_eq!(rows[0].last_error_code, Some("smtp_auth_failed".to_string()));
}

#[test]
fn send_queue_worker_is_idempotent() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send(&connection);
    let adapter = FakeSmtpAdapter::success();

    let first = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("first worker");
    let second = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:01Z".to_string(),
    )
    .expect("second worker");

    assert_eq!(first.processed_count, 1);
    assert_eq!(second.processed_count, 0);
    assert_eq!(adapter.sent_messages().len(), 1);
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml smtp_retryable_error_requeues_with_backoff
cargo test --manifest-path src-tauri/Cargo.toml smtp_auth_failure_sets_action_required
cargo test --manifest-path src-tauri/Cargo.toml send_queue_worker_is_idempotent
```

Expected before implementation: worker module and run function do not exist.

- [x] **Step 3: Implement worker**

Implement:

- `SendQueueWorkerRunResult { processed_count, sent_count, retry_count, failed_count }`
- `run_send_queue_once`
  - Claims one due queue item.
  - Loads SMTP profile/source and secret.
  - Sends with `SmtpAdapter`.
  - On success: mark `sent`, set `sent_at`, record provider message id in queue error/message metadata only if no secret material is included.
  - On retryable failure: status returns to `queued`, increment attempt count, set `next_retry_at = now + 60 seconds` for attempt 1 and `now + 300 seconds` for attempt 2+.
  - On auth failure: status `auth_failed`, action needed by user.
  - On permanent failure: status `failed`.

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: all pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/workers src-tauri/src/lib.rs src-tauri/src/storage/send_queue_repository.rs
git commit -m "feat: process send queue jobs"
```

---

## Task 5: Commands and UI for send queue

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Write failing command tests**

Add tests:

```rust
#[test]
fn send_queue_row_dto_does_not_expose_secret_metadata() {
    let row = SendQueueRow {
        id: "send_1".to_string(),
        account_id: "acct_send".to_string(),
        source_id: "src_smtp".to_string(),
        message_id: "msg_outgoing".to_string(),
        target_address: "target@example.test".to_string(),
        subject: "Hello".to_string(),
        status: "queued".to_string(),
        attempt_count: 0,
        next_retry_at: None,
        last_error_code: None,
        last_error_message: None,
        created_at: "2026-06-12T01:00:00Z".to_string(),
        updated_at: "2026-06-12T01:00:00Z".to_string(),
        sent_at: None,
        credential_ref_id: Some("cred_1".to_string()),
        secret_key: Some("secret://smtp/account-1".to_string()),
    };

    let dto = send_queue_row_to_dto(row);
    let serialized = serde_json::to_string(&dto).expect("serialize dto");

    assert!(!serialized.contains("secret://smtp/account-1"));
    assert!(!serialized.contains("credential_ref_id"));
}
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml send_queue_row_dto_does_not_expose_secret_metadata
```

Expected before implementation: command DTO/helper does not exist.

- [x] **Step 3: Implement commands and UI**

Commands:

- `send_message`
- `send_queue_list`
- `send_queue_run_once`

UI:

- Compose form with sender account, target address, subject, body text.
- Send button calls `send_message`, then refreshes queue.
- Queue panel shows status, attempt count, next retry, last error, sent time.
- Worker button calls `send_queue_run_once`.
- UI text states sending is queued and SMTP is processed separately.

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
git commit -m "feat: add send queue UI"
```

---

## Task 6: Full verification and tracker closeout

**Files:**
- Modify: `docs/progress/MASTER.md`
- Modify: `docs/progress/phase-7-smtp-send-queue.md`
- Modify: `docs/superpowers/plans/2026-06-12-easyemailam-smtp-send-queue.md`

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

- `docs/progress/phase-7-smtp-send-queue.md`: mark all Phase 7 tasks complete with evidence.
- `docs/progress/MASTER.md`: Phase 7 becomes 7/7, overall progress becomes 57/68, active phase becomes Phase 8.

- [x] **Step 3: Mark this plan complete**

Change all plan checkboxes to `- [x]` after evidence exists and append an execution record containing red/green/full verification evidence and commits.

- [x] **Step 4: Commit closeout**

Run:

```powershell
git add docs/progress docs/superpowers/plans/2026-06-12-easyemailam-smtp-send-queue.md
git commit -m "docs: mark smtp send queue phase executed"
git status --short --branch
```

---

## Execution record

Completed on branch `foundation`.

### Red evidence

- Task 1 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml fake_smtp_adapter_sends_message`
  - `cargo test --manifest-path src-tauri/Cargo.toml native_smtp_adapter_reports_unsupported_until_dependency_exists`
  - Expected failure: SMTP modules, models, `FakeSmtpAdapter`, and `NativeSmtpAdapter` did not exist.
- Task 2 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml send_queue_repository_enqueues_queued_job`
  - `cargo test --manifest-path src-tauri/Cargo.toml claim_next_due_send_marks_job_sending_once`
  - Expected failure: `NewSendQueueItem`, `enqueue_send`, and `claim_next_due_send` were missing.
- Task 3 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml send_message_requires_send_enabled`
  - `cargo test --manifest-path src-tauri/Cargo.toml anonymous_account_cannot_send`
  - `cargo test --manifest-path src-tauri/Cargo.toml send_message_enqueues_without_calling_smtp`
  - Expected failure: `SendMessageRequest` and `enqueue_send_message` were missing.
- Task 4 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml smtp_retryable_error_requeues_with_backoff`
  - `cargo test --manifest-path src-tauri/Cargo.toml smtp_auth_failure_sets_action_required`
  - `cargo test --manifest-path src-tauri/Cargo.toml send_queue_worker_is_idempotent`
  - Expected failure: `run_send_queue_once` was missing.
- Task 5 red:
  - `cargo test --manifest-path src-tauri/Cargo.toml send_queue_row_dto_does_not_expose_secret_metadata`
  - Expected failure: `send_queue_row_to_dto` was missing.

### Green evidence

- Task 1 green:
  - `cargo fmt --manifest-path src-tauri/Cargo.toml`
  - `cargo test --manifest-path src-tauri/Cargo.toml fake_smtp_adapter_sends_message`
  - `cargo test --manifest-path src-tauri/Cargo.toml native_smtp_adapter_reports_unsupported_until_dependency_exists`
  - Commit: `8b7adb9 feat: add smtp adapter boundary`.
- Task 2 green:
  - `cargo fmt --manifest-path src-tauri/Cargo.toml`
  - `cargo test --manifest-path src-tauri/Cargo.toml send_queue_repository_enqueues_queued_job`
  - `cargo test --manifest-path src-tauri/Cargo.toml claim_next_due_send_marks_job_sending_once`
  - `cargo test --manifest-path src-tauri/Cargo.toml migrations_apply_cleanly`
  - Commit: `097255a feat: add send queue repository`.
- Task 3 green:
  - `cargo fmt --manifest-path src-tauri/Cargo.toml`
  - `cargo test --manifest-path src-tauri/Cargo.toml send_message_requires_send_enabled`
  - `cargo test --manifest-path src-tauri/Cargo.toml anonymous_account_cannot_send`
  - `cargo test --manifest-path src-tauri/Cargo.toml send_message_enqueues_without_calling_smtp`
  - Commit: `6ce748b feat: enqueue normal account sends`.
- Task 4 green:
  - `cargo fmt --manifest-path src-tauri/Cargo.toml`
  - `cargo test --manifest-path src-tauri/Cargo.toml smtp_retryable_error_requeues_with_backoff`
  - `cargo test --manifest-path src-tauri/Cargo.toml smtp_auth_failure_sets_action_required`
  - `cargo test --manifest-path src-tauri/Cargo.toml send_queue_worker_is_idempotent`
  - Commit: `4e77bdb feat: process send queue jobs`.
- Task 5 green:
  - `cargo fmt --manifest-path src-tauri/Cargo.toml`
  - `cargo test --manifest-path src-tauri/Cargo.toml send_queue_row_dto_does_not_expose_secret_metadata`
  - `npm run build`
  - `cargo check --manifest-path src-tauri/Cargo.toml`
  - Commit: `3f6fc62 feat: add send queue UI`.
- Clippy fix:
  - `cargo test --manifest-path src-tauri/Cargo.toml send_message_enqueues_without_calling_smtp`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
  - Commit: `ea73eaf refactor: group outgoing message insert input`.

### Full verification

- First full verification:
  - `npm run verify` passed with 72 Rust tests.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` failed on `clippy::too_many_arguments` for `insert_outgoing_message`.
- Root cause and fix:
  - Root cause: `insert_outgoing_message` used 8 parameters instead of the repository pattern of grouping input into a `New*` struct.
  - Fix: introduced `NewOutgoingMessage` and updated the send service call site.
- Final full verification:
  - `npm run verify` passed.
  - `cargo test --manifest-path src-tauri/Cargo.toml` inside verify passed with 72 tests.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

### Tracker updates

- `docs/progress/phase-7-smtp-send-queue.md`: 7/7 tasks checked with evidence.
- `docs/progress/MASTER.md`: Phase 7 marked complete, overall progress updated to 57/68, active phase moved to Phase 8.
