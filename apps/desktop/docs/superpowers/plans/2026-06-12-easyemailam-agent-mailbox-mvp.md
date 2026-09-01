# Agent Mailbox MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Milestone 8 from the approved EasyEmailAM spec: Agent mailbox account workflow, remote Agent services, Agent task threads/messages, queued Agent task send, reply linking, and needs-attention handling.

**Architecture:** Agent mail is separate from normal human mail. Agent sender accounts use `accounts.scope = 'agent'` and never appear in normal account lists. Agent task sending creates `agent_threads`, outgoing `messages`, `agent_messages`, and `send_queue` rows; reply association indexes incoming messages into `agent_messages` by headers first, then creates `needs_attention` threads for unmatched known-Agent replies.

**Tech Stack:** Rust 2021, rusqlite, serde/serde_json, Tauri 2 commands, React 19, TypeScript, Vite.

---

## File structure

- Modify `src-tauri/migrations/0001_foundation.sql`
  - Add `agent_services`, `agent_threads`, and `agent_messages`.
- Modify `src-tauri/src/storage/migrations.rs`
  - Include Agent tables in migration smoke test.
- Create `src-tauri/src/storage/agent_repository.rs`
  - Agent service CRUD.
  - Agent thread creation/detail.
  - Agent message indexing.
  - Reply association helpers.
- Modify `src-tauri/src/storage/account_repository.rs`
  - Add helper to insert/list Agent accounts.
  - Add helper to load send-capable Agent SMTP source.
- Modify `src-tauri/src/storage/message_repository.rs`
  - Add helper to load message headers/body needed by Agent reply association.
- Modify `src-tauri/src/storage/mod.rs`
  - Export `agent_repository`.
- Create `src-tauri/src/services/agent_service.rs`
  - Add Agent mailbox account.
  - Add remote Agent service.
  - Create/send Agent task mail.
  - Associate incoming Agent replies.
- Modify `src-tauri/src/services/mod.rs`
  - Export Agent service.
- Modify `src-tauri/src/commands.rs`
  - Add:
    - `agent_add_account`
    - `agent_list_accounts`
    - `agent_add_service`
    - `agent_list_services`
    - `agent_create_task_draft`
    - `agent_send_task`
    - `agent_list_threads`
    - `agent_get_thread_detail`
- Modify `src-tauri/src/lib.rs`
  - Register commands.
- Modify `src/App.tsx` and `src/App.css`
  - Add Agent account/service/task UI.
  - Add Agent thread/detail panel.

---

## Task 1: Agent schema, repositories, and account visibility

**Files:**
- Modify: `src-tauri/migrations/0001_foundation.sql`
- Modify: `src-tauri/src/storage/migrations.rs`
- Create: `src-tauri/src/storage/agent_repository.rs`
- Modify: `src-tauri/src/storage/account_repository.rs`
- Modify: `src-tauri/src/storage/mod.rs`

- [x] **Step 1: Write failing tests**

Add tests:

```rust
#[test]
fn agent_account_is_not_listed_in_normal_accounts() {
    let connection = test_connection();

    let account = insert_agent_account(
        &connection,
        NewAgentAccount {
            display_name: "Agent Sender".to_string(),
            email_address: "agent@example.test".to_string(),
            now: "2026-06-12T02:00:00Z".to_string(),
        },
    )
    .expect("insert agent account");
    let normal_accounts = list_normal_accounts(&connection).expect("normal accounts");
    let agent_accounts = list_agent_accounts(&connection).expect("agent accounts");

    assert_eq!(account.scope, "agent");
    assert!(normal_accounts.iter().all(|row| row.id != account.id));
    assert_eq!(agent_accounts.len(), 1);
}

#[test]
fn agent_service_repository_persists_trust_level() {
    let connection = test_connection();

    let service = insert_agent_service(
        &connection,
        NewAgentService {
            display_name: "Remote Agent".to_string(),
            email_address: "remote-agent@example.test".to_string(),
            description: Some("Handles research tasks".to_string()),
            service_kind: "email_agent".to_string(),
            trust_level: "restricted".to_string(),
            default_sender_account_id: Some("acct_agent".to_string()),
            now: "2026-06-12T02:00:00Z".to_string(),
        },
    )
    .expect("insert service");

    assert_eq!(service.trust_level, "restricted");
    assert_eq!(list_agent_services(&connection).expect("services").len(), 1);
}

#[test]
fn agent_thread_repository_returns_detail_with_messages() {
    let connection = test_connection();
    seed_agent_service_and_message(&connection);

    let thread = create_agent_thread(
        &connection,
        NewAgentThread {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            correlation_key: "thread-key-1".to_string(),
            now: "2026-06-12T02:10:00Z".to_string(),
        },
    )
    .expect("create thread");
    insert_agent_message(
        &connection,
        NewAgentMessage {
            thread_id: thread.id.clone(),
            message_id: "msg_outgoing".to_string(),
            direction: "outgoing".to_string(),
            semantic_role: "task_request".to_string(),
            parsed_status: Some("sent".to_string()),
            parsed_payload_json: "{}".to_string(),
            now: "2026-06-12T02:11:00Z".to_string(),
        },
    )
    .expect("insert agent message");

    let detail = get_agent_thread_detail(&connection, &thread.id)
        .expect("detail")
        .expect("thread exists");

    assert_eq!(detail.thread.subject, "Research task");
    assert_eq!(detail.messages.len(), 1);
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml agent_account_is_not_listed_in_normal_accounts
cargo test --manifest-path src-tauri/Cargo.toml agent_service_repository_persists_trust_level
cargo test --manifest-path src-tauri/Cargo.toml agent_thread_repository_returns_detail_with_messages
```

Expected before implementation: Agent repository APIs and tables do not exist.

- [x] **Step 3: Implement schema and repositories**

Implement:

- `agent_services` table with `trust_level` check values `unknown`, `trusted`, `restricted`, `blocked`.
- `agent_threads` table with status check values from the spec.
- `agent_messages` table with direction check values `outgoing`, `incoming`.
- `AgentServiceRow`, `NewAgentService`, `insert_agent_service`, `list_agent_services`, `get_agent_service`.
- `AgentThreadRow`, `NewAgentThread`, `create_agent_thread`, `update_agent_thread_after_outgoing`, `update_agent_thread_after_incoming`.
- `AgentMessageRow`, `NewAgentMessage`, `insert_agent_message`.
- `AgentThreadDetail`, `get_agent_thread_detail`, `list_agent_threads`.
- `insert_agent_account`, `list_agent_accounts`.

- [x] **Step 4: Verify tests**

Run Step 2 commands plus:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml migrations_apply_cleanly
```

Expected: all pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/migrations/0001_foundation.sql src-tauri/src/storage/agent_repository.rs src-tauri/src/storage/account_repository.rs src-tauri/src/storage/migrations.rs src-tauri/src/storage/mod.rs
git commit -m "feat: add agent mailbox repositories"
```

---

## Task 2: Agent task send service and trust enforcement

**Files:**
- Create: `src-tauri/src/services/agent_service.rs`
- Modify: `src-tauri/src/services/mod.rs`

- [x] **Step 1: Write failing service tests**

Add required tests:

```rust
#[test]
fn agent_task_requires_agent_scope_sender() {
    let connection = test_connection();
    seed_normal_sender_and_agent_service(&connection, "trusted");

    let error = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_normal".to_string(),
            subject: "Research task".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect_err("normal sender blocked");

    assert_eq!(error.code, "agent_sender_scope_required");
}

#[test]
fn blocked_agent_service_rejects_send() {
    let connection = test_connection();
    seed_agent_sender_and_service(&connection, "blocked");

    let error = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect_err("blocked service rejected");

    assert_eq!(error.code, "agent_service_blocked");
}

#[test]
fn restricted_agent_service_requires_confirmation() {
    let connection = test_connection();
    seed_agent_sender_and_service(&connection, "restricted");

    let error = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect_err("confirmation required");

    assert_eq!(error.code, "agent_service_restricted_confirmation_required");
}

#[test]
fn trusted_agent_task_send_creates_thread_message_and_queue() {
    let connection = test_connection();
    seed_agent_sender_and_service(&connection, "trusted");

    let result = agent_send_task(
        &connection,
        AgentSendTaskRequest {
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            body_text: "Please summarize this.".to_string(),
            confirm_restricted: false,
        },
        "2026-06-12T02:20:00Z".to_string(),
    )
    .expect("send task");

    assert_eq!(result.thread.status, "awaiting_reply");
    assert_eq!(result.queue.status, "queued");
    assert_eq!(result.agent_message.direction, "outgoing");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml agent_task_requires_agent_scope_sender
cargo test --manifest-path src-tauri/Cargo.toml blocked_agent_service_rejects_send
cargo test --manifest-path src-tauri/Cargo.toml restricted_agent_service_requires_confirmation
cargo test --manifest-path src-tauri/Cargo.toml trusted_agent_task_send_creates_thread_message_and_queue
```

Expected before implementation: Agent service APIs do not exist.

- [x] **Step 3: Implement Agent task send service**

Implement:

- `AgentSendTaskRequest`
- `AgentSendTaskResult`
- `agent_send_task`
  - Sender must exist with `scope = 'agent'`.
  - Sender must have `send_status = 'enabled'`.
  - Agent service `trust_level = 'blocked'` returns `agent_service_blocked`.
  - Agent service `trust_level = 'restricted'` requires `confirm_restricted = true`.
  - Creates outgoing message through the Agent SMTP source.
  - Creates agent thread with status `awaiting_reply`.
  - Inserts outgoing `agent_messages` row with semantic role `task_request`.
  - Enqueues send through `send_queue`.

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: all pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/services/agent_service.rs src-tauri/src/services/mod.rs src-tauri/src/storage/agent_repository.rs src-tauri/src/storage/account_repository.rs src-tauri/src/storage/message_repository.rs
git commit -m "feat: send agent task mail"
```

---

## Task 3: Agent reply association and needs-attention handling

**Files:**
- Modify: `src-tauri/src/storage/agent_repository.rs`
- Modify: `src-tauri/src/services/agent_service.rs`

- [x] **Step 1: Write failing reply tests**

Add required tests:

```rust
#[test]
fn incoming_reply_links_by_in_reply_to() {
    let connection = test_connection();
    seed_agent_thread_with_outgoing_message(&connection);
    seed_incoming_agent_reply(&connection, "msg_reply", "remote-agent@example.test");

    let result = associate_incoming_agent_reply(
        &connection,
        AgentReplyAssociationRequest {
            message_id: "msg_reply".to_string(),
            from_address: "remote-agent@example.test".to_string(),
            in_reply_to_message_id: Some("<outgoing@example.test>".to_string()),
            references: Vec::new(),
        },
        "2026-06-12T02:30:00Z".to_string(),
    )
    .expect("associate reply");

    assert_eq!(result.status, "linked");
    assert_eq!(result.thread.status, "in_progress");
    assert_eq!(result.agent_message.direction, "incoming");
}

#[test]
fn unmatched_agent_reply_goes_to_needs_attention() {
    let connection = test_connection();
    seed_agent_service_only(&connection);
    seed_incoming_agent_reply(&connection, "msg_unmatched", "remote-agent@example.test");

    let result = associate_incoming_agent_reply(
        &connection,
        AgentReplyAssociationRequest {
            message_id: "msg_unmatched".to_string(),
            from_address: "remote-agent@example.test".to_string(),
            in_reply_to_message_id: None,
            references: Vec::new(),
        },
        "2026-06-12T02:35:00Z".to_string(),
    )
    .expect("associate unmatched");

    assert_eq!(result.status, "needs_attention");
    assert_eq!(result.thread.status, "needs_attention");
    assert_eq!(result.agent_message.direction, "incoming");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml incoming_reply_links_by_in_reply_to
cargo test --manifest-path src-tauri/Cargo.toml unmatched_agent_reply_goes_to_needs_attention
```

Expected before implementation: reply association APIs do not exist.

- [x] **Step 3: Implement reply association**

Implement:

- `AgentReplyAssociationRequest`
- `AgentReplyAssociationResult`
- `associate_incoming_agent_reply`
  - Loads incoming message.
  - Finds known Agent service by `email_address`.
  - First matches `in_reply_to_message_id` or `references` against the outgoing message `rfc_message_id`.
  - If matched: insert incoming `agent_messages`, update thread `last_incoming_message_id`, set status `in_progress`.
  - If known Agent but unmatched: create new thread with status `needs_attention`, insert incoming `agent_messages`.
  - Unknown sender returns `agent_service_unknown`.

- [x] **Step 4: Verify tests**

Run Step 2 commands. Expected: both pass.

- [x] **Step 5: Commit**

Run:

```powershell
git add src-tauri/src/storage/agent_repository.rs src-tauri/src/services/agent_service.rs
git commit -m "feat: associate agent replies"
```

---

## Task 4: Commands and UI for Agent mailbox MVP

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Write failing command tests**

Add tests:

```rust
#[test]
fn agent_thread_detail_dto_does_not_expose_secret_metadata() {
    let detail = AgentThreadDetail {
        thread: AgentThreadRow {
            id: "agthread_1".to_string(),
            agent_service_id: "agsvc_1".to_string(),
            sender_account_id: "acct_agent".to_string(),
            subject: "Research task".to_string(),
            status: "awaiting_reply".to_string(),
            last_outgoing_message_id: Some("msg_outgoing".to_string()),
            last_incoming_message_id: None,
            correlation_key: "corr_1".to_string(),
            created_at: "2026-06-12T02:20:00Z".to_string(),
            updated_at: "2026-06-12T02:20:00Z".to_string(),
            completed_at: None,
        },
        messages: vec![AgentMessageRow {
            id: "agmsg_1".to_string(),
            thread_id: "agthread_1".to_string(),
            message_id: "msg_outgoing".to_string(),
            direction: "outgoing".to_string(),
            semantic_role: "task_request".to_string(),
            parsed_status: Some("queued".to_string()),
            parsed_payload_json: "{\"secret_key\":\"secret://smtp/acct_agent\"}".to_string(),
            created_at: "2026-06-12T02:20:00Z".to_string(),
        }],
    };

    let dto = agent_thread_detail_to_dto(detail);
    let serialized = serde_json::to_string(&dto).expect("serialize dto");

    assert!(!serialized.contains("secret://smtp/acct_agent"));
    assert!(!serialized.contains("secret_key"));
}
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml agent_thread_detail_dto_does_not_expose_secret_metadata
```

Expected before implementation: Agent command DTO/helper does not exist.

- [x] **Step 3: Implement commands and UI**

Commands:

- `agent_add_account`
- `agent_list_accounts`
- `agent_add_service`
- `agent_list_services`
- `agent_send_task`
- `agent_list_threads`
- `agent_get_thread_detail`

UI:

- Agent sender account creation card.
- Remote Agent service creation card with trust level.
- Agent task compose card with restricted confirmation checkbox.
- Agent thread list and detail panel.
- Warning copy that Agent accounts are excluded from normal accounts.

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
git commit -m "feat: add agent mailbox UI"
```

---

## Task 5: Full verification and tracker closeout

**Files:**
- Modify: `docs/progress/MASTER.md`
- Modify: `docs/progress/phase-8-agent-mailbox.md`
- Modify: `docs/superpowers/plans/2026-06-12-easyemailam-agent-mailbox-mvp.md`

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

- `docs/progress/phase-8-agent-mailbox.md`: mark all Phase 8 tasks complete with evidence.
- `docs/progress/MASTER.md`: Phase 8 becomes 9/9, overall progress becomes 66/68, active work moves to Phase 0 gap closure.

- [x] **Step 3: Mark this plan complete**

Change all plan checkboxes to `- [x]` after evidence exists and append an execution record containing red/green/full verification evidence and commits.

- [x] **Step 4: Commit closeout**

Run:

```powershell
git add docs/progress docs/superpowers/plans/2026-06-12-easyemailam-agent-mailbox-mvp.md
git commit -m "docs: mark agent mailbox phase executed"
git status --short --branch
```

---

## Execution record

- Task 1 committed `9712ebd feat: add agent mailbox repositories`.
  - Verified targeted Agent repository/account tests and `migrations_apply_cleanly`.
- Task 2 committed `df4e7e1 feat: send agent task mail`.
  - Verified Agent task trust/scope/send queue tests.
- Task 3 committed `f007a54 feat: associate agent replies`.
  - Red: `cargo test --manifest-path src-tauri/Cargo.toml incoming_reply_links_by_in_reply_to` and `unmatched_agent_reply_goes_to_needs_attention` failed because `AgentReplyAssociationRequest` and `associate_incoming_agent_reply` did not exist.
  - Green: both targeted tests passed after implementation.
  - Regression: `cargo test --manifest-path src-tauri/Cargo.toml agent_service` passed 7 tests.
- Task 4 committed `726dbfb feat: add agent mailbox UI`.
  - Red: `cargo test --manifest-path src-tauri/Cargo.toml agent_thread_detail_dto_does_not_expose_secret_metadata` failed because `agent_thread_detail_to_dto` did not exist.
  - Green: the targeted DTO redaction test passed after implementation.
  - Compile verification: `npm run build` passed and `cargo check --manifest-path src-tauri/Cargo.toml` passed.
  - Regression: `cargo test --manifest-path src-tauri/Cargo.toml commands::tests` passed 9 tests.
- Phase closeout verification:
  - `npm run verify` passed: production build, `cargo fmt`, 82 Rust tests, and `cargo check`.
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
