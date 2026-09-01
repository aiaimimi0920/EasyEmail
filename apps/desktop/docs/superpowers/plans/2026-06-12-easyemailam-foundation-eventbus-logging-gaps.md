# Foundation EventBus and Logging Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining Phase 0 foundation tasks by adding minimal, tested EventBus and diagnostic logging skeletons.

**Architecture:** Add small backend-only modules rather than wiring business workflows through them yet. `events.rs` defines a redacting in-memory event bus abstraction for future workers. `diagnostics.rs` defines a redacting diagnostic logger/export boundary. `AppState` owns both skeletons so future commands/workers can depend on shared infrastructure without direct UI assumptions.

**Tech Stack:** Rust 2021, serde/serde_json, existing EasyEmailAM redaction module, Tauri shared `AppState`.

---

## File structure

- Create `src-tauri/src/events.rs`
  - `AppEvent` data shape.
  - `EventBus` trait.
  - `InMemoryEventBus` skeleton with redacted payload storage.
- Create `src-tauri/src/diagnostics.rs`
  - `DiagnosticLogLevel`, `DiagnosticLogEntry`, `NewDiagnosticLogEntry`.
  - `DiagnosticLogger` skeleton with redacted message/metadata storage.
  - Default diagnostic export that excludes message bodies.
- Modify `src-tauri/src/app_state.rs`
  - Add `event_bus` and `diagnostic_logger` fields.
- Modify `src-tauri/src/lib.rs`
  - Export `events` and `diagnostics` modules.
- Modify `docs/progress/phase-0-foundation.md`
  - Mark EventBus and Logging skeleton complete with evidence.
- Modify `docs/progress/MASTER.md`
  - Phase 0 becomes 9/9 and overall becomes 68/68.

---

## Task 1: EventBus skeleton

**Files:**
- Create: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/app_state.rs`

- [x] **Step 1: Write failing EventBus test**

Add this test in `src-tauri/src/events.rs`:

```rust
#[test]
fn event_bus_records_redacted_backend_events() {
    let bus = InMemoryEventBus::default();

    bus.emit(AppEvent::new(
        "agent_thread_updated",
        serde_json::json!({
            "thread_id": "agthread_1",
            "password": "secret-password",
        }),
        "2026-06-12T04:00:00Z".to_string(),
    ));

    let events = bus.snapshot();
    let serialized = serde_json::to_string(&events).expect("serialize events");

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "agent_thread_updated");
    assert_eq!(events[0].payload["thread_id"], "agthread_1");
    assert!(!serialized.contains("secret-password"));
    assert_eq!(events[0].payload["password"], "[REDACTED]");
}
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml event_bus_records_redacted_backend_events
```

Expected before implementation: `events` module and EventBus types do not exist.

- [x] **Step 3: Implement minimal EventBus**

Implement:

- `AppEvent { kind, payload, emitted_at }`
- `AppEvent::new(kind, payload, emitted_at)` using `crate::redaction::redact_json`.
- `EventBus` trait with `emit(&self, event: AppEvent)`.
- `InMemoryEventBus` backed by `Mutex<Vec<AppEvent>>`.
- `snapshot(&self) -> Vec<AppEvent>` for diagnostics/tests.
- Export module from `lib.rs`.
- Add `pub event_bus: InMemoryEventBus` to `AppState::open_default()`.

- [x] **Step 4: Verify EventBus**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml event_bus_records_redacted_backend_events
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/events.rs src-tauri/src/lib.rs src-tauri/src/app_state.rs
git commit -m "feat: add event bus skeleton"
```

---

## Task 2: Diagnostic logging skeleton

**Files:**
- Create: `src-tauri/src/diagnostics.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/app_state.rs`

- [x] **Step 1: Write failing logging tests**

Add these tests in `src-tauri/src/diagnostics.rs`:

```rust
#[test]
fn logs_redact_password_fields() {
    let logger = DiagnosticLogger::default();

    logger.log(NewDiagnosticLogEntry {
        level: DiagnosticLogLevel::Warn,
        target: "imap".to_string(),
        message: "password=plain-secret failed".to_string(),
        metadata: serde_json::json!({
            "account_id": "acct_1",
            "password": "plain-secret",
        }),
        occurred_at: "2026-06-12T04:05:00Z".to_string(),
    });

    let export = logger.export_default();
    let serialized = serde_json::to_string(&export).expect("serialize export");

    assert!(!serialized.contains("plain-secret"));
    assert!(serialized.contains("password=[REDACTED]"));
    assert_eq!(export.logs[0].metadata["password"], "[REDACTED]");
}

#[test]
fn logs_redact_oauth_tokens() {
    let logger = DiagnosticLogger::default();

    logger.log(NewDiagnosticLogEntry {
        level: DiagnosticLogLevel::Error,
        target: "oauth".to_string(),
        message: "access_token=abc refresh_token=def".to_string(),
        metadata: serde_json::json!({
            "access_token": "abc",
            "refresh_token": "def",
        }),
        occurred_at: "2026-06-12T04:06:00Z".to_string(),
    });

    let export = logger.export_default();
    let serialized = serde_json::to_string(&export).expect("serialize export");

    assert!(!serialized.contains("abc"));
    assert!(!serialized.contains("def"));
    assert_eq!(export.logs[0].metadata["access_token"], "[REDACTED]");
    assert_eq!(export.logs[0].metadata["refresh_token"], "[REDACTED]");
}

#[test]
fn diagnostic_export_excludes_message_body_by_default() {
    let logger = DiagnosticLogger::default();

    logger.log(NewDiagnosticLogEntry {
        level: DiagnosticLogLevel::Info,
        target: "message_fetch".to_string(),
        message: "stored message metadata".to_string(),
        metadata: serde_json::json!({
            "message_id": "msg_1",
            "body_text": "full private body",
            "nested": {
                "body_html": "<p>full private body</p>"
            }
        }),
        occurred_at: "2026-06-12T04:07:00Z".to_string(),
    });

    let export = logger.export_default();
    let serialized = serde_json::to_string(&export).expect("serialize export");

    assert!(!serialized.contains("full private body"));
    assert_eq!(export.logs[0].metadata["body_text"], "[REDACTED_BODY]");
    assert_eq!(export.logs[0].metadata["nested"]["body_html"], "[REDACTED_BODY]");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml logs_redact_password_fields
cargo test --manifest-path src-tauri/Cargo.toml logs_redact_oauth_tokens
cargo test --manifest-path src-tauri/Cargo.toml diagnostic_export_excludes_message_body_by_default
```

Expected before implementation: `diagnostics` module and logger types do not exist.

- [x] **Step 3: Implement minimal diagnostics logger**

Implement:

- `DiagnosticLogLevel` enum serialized as snake_case.
- `NewDiagnosticLogEntry` input struct.
- `DiagnosticLogEntry` output struct.
- `DiagnosticExport` output struct.
- `DiagnosticLogger` backed by `Mutex<Vec<DiagnosticLogEntry>>`.
- `DiagnosticLogger::log()` redacts message text via `redact_text`.
- `DiagnosticLogger::log()` redacts metadata via `redact_json` and replaces body fields with `[REDACTED_BODY]`.
- `DiagnosticLogger::export_default()` returns redacted log entries only.
- Export module from `lib.rs`.
- Add `pub diagnostic_logger: DiagnosticLogger` to `AppState::open_default()`.

- [x] **Step 4: Verify diagnostics**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml logs_redact_password_fields
cargo test --manifest-path src-tauri/Cargo.toml logs_redact_oauth_tokens
cargo test --manifest-path src-tauri/Cargo.toml diagnostic_export_excludes_message_body_by_default
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/diagnostics.rs src-tauri/src/lib.rs src-tauri/src/app_state.rs
git commit -m "feat: add diagnostic logging skeleton"
```

---

## Task 3: Foundation closeout

**Files:**
- Modify: `docs/progress/phase-0-foundation.md`
- Modify: `docs/progress/MASTER.md`
- Modify: `docs/superpowers/plans/2026-06-12-easyemailam-foundation-eventbus-logging-gaps.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: production build, formatter, Rust tests, Rust check, and clippy all pass.

- [x] **Step 2: Update progress trackers**

Update:

- `docs/progress/phase-0-foundation.md`: EventBus and Logging skeleton tasks complete with evidence.
- `docs/progress/MASTER.md`: Phase 0 becomes 9/9, overall progress becomes 68/68, current status says all tracked tasks are complete pending final clean-status check.

- [x] **Step 3: Mark this plan complete**

Change this plan's checkboxes to `- [x]` and append execution evidence with commands and commits.

- [x] **Step 4: Commit closeout**

Run:

```powershell
git add docs/progress docs/superpowers/plans/2026-06-12-easyemailam-foundation-eventbus-logging-gaps.md
git commit -m "docs: close foundation gaps"
git status --short --branch
```

---

## Execution record

- Plan committed `5446489 docs: plan foundation gap closure`.
- Task 1 committed `54c8bb1 feat: add event bus skeleton`.
  - Red: `cargo test --manifest-path src-tauri/Cargo.toml event_bus_records_redacted_backend_events` failed because `InMemoryEventBus` and `AppEvent` did not exist.
  - Green: EventBus target test passed after implementation.
  - Verification: `cargo fmt --manifest-path src-tauri/Cargo.toml`, target test, and `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Task 2 committed `a569de2 feat: add diagnostic logging skeleton`.
  - Red: `logs_redact_password_fields`, `logs_redact_oauth_tokens`, and `diagnostic_export_excludes_message_body_by_default` failed because diagnostics logger types did not exist.
  - Green: all three targeted tests passed after implementation.
  - Verification: `cargo fmt --manifest-path src-tauri/Cargo.toml`, targeted tests, and `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Foundation closeout verification:
  - `npm run verify` passed: production build, `cargo fmt`, 86 Rust tests, and `cargo check`.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
