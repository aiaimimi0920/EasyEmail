# Temp Mailbox Fetch and Anonymous Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` / `- [x]`) syntax for tracking.

**Goal:** Build Milestone 3 from the approved EasyEmailAM spec: fetch messages for EasyEmail temporary mailboxes, persist them idempotently, expose anonymous message aggregation, and add refresh/list UI.

**Architecture:** Extend the existing EasyEmail adapter boundary with `fetch_temp_messages`, keep provider fetching inside EasyEmail, and map only canonical observed-message fields into EasyEmailAM. The service layer refreshes temp mailboxes and owns lifecycle skip rules; SQLite repositories own source creation, message/source idempotency, and anonymous-scope queries. Tauri commands and React UI expose synchronous refresh actions now, leaving a background worker/event bus upgrade for a later pass.

**Tech Stack:** Tauri 2, React 19, TypeScript, Rust 1.95, rusqlite, serde_json, ureq blocking HTTP, SQLite `temp_mailboxes`, `mailbox_sources`, `messages`, and `message_sources`.

---

## Scope and source facts

This plan implements `docs/superpowers/specs/2026-06-11-easyemailam-design.md` Milestone 3:

```text
EasyEmailAdapter.fetch_temp_messages
TempMailboxFetchWorker
temp_refresh_mailbox
temp_refresh_anonymous
message_list scope=anonymous
anonymous mailbox UI
message deduplication
```

EasyEmail API facts verified from sibling repo `C:\Users\Public\nas_home\AI\GameEditor\EasyEmail`:

- Observed-message query route constant: `/mail/query/observed-messages`.
- Admin query accepts query parameters from `ObservedMessageQueryFilters`: `sessionId`, `providerInstanceId`, `extractedCodeOnly`, `sync`, `limit`, `newestFirst`.
- Query response shape: `{ "messages": ObservedMessage[] }`.
- `ObservedMessage` contains `id`, `sessionId`, `providerInstanceId`, `observedAt`, optional `sender`, optional `subject`, optional `htmlBody`, optional `textBody`, optional `extractedCode`, and optional candidates/action links.

Milestone 3 explicitly does not implement verification-code records, code copy UI, mailbox promotion commands/UI, IMAP, SMTP, or a real background scheduler.

## File structure

Create or modify:

```text
src-tauri/src/domain/message.rs
src-tauri/src/easyemail/adapter.rs
src-tauri/src/easyemail/fake.rs
src-tauri/src/easyemail/http.rs
src-tauri/src/easyemail/models.rs
src-tauri/src/storage/message_repository.rs
src-tauri/src/storage/temp_mailbox_repository.rs
src-tauri/src/services/easyemail_service.rs
src-tauri/src/commands.rs
src-tauri/src/lib.rs
src/App.tsx
src/App.css
docs/progress/MASTER.md
docs/progress/phase-1-core-schema.md
docs/progress/phase-3-temp-fetch-anonymous.md
docs/superpowers/plans/2026-06-12-easyemailam-temp-fetch-anonymous.md
```

Responsibility boundaries:

- `easyemail/models.rs`: canonical observed-message models and EasyEmail response mapping.
- `easyemail/http.rs`: blocking HTTP implementation for `GET /mail/query/observed-messages?sessionId=...&sync=true&newestFirst=true`.
- `easyemail/fake.rs`: deterministic fake fetch responses and fetch-call recording for service tests.
- `storage/temp_mailbox_repository.rs`: list refresh candidates, read row fields including `source_id`, update source/lifecycle timestamps.
- `storage/message_repository.rs`: create EasyEmail temp mailbox source, insert messages idempotently, query anonymous message rows.
- `services/easyemail_service.rs`: refresh-one and refresh-all orchestration plus lifecycle skip rules.
- `commands.rs`: command DTOs for `temp_refresh_mailbox`, `temp_refresh_anonymous`, and `message_list`.
- `App.tsx`: refresh controls and anonymous message list.

---

## Task 1: Adapter observed-message fetch

**Files:**
- Modify: `src-tauri/src/easyemail/adapter.rs`
- Modify: `src-tauri/src/easyemail/models.rs`
- Modify: `src-tauri/src/easyemail/fake.rs`
- Modify: `src-tauri/src/easyemail/http.rs`

- [x] **Step 1: Write failing adapter tests**

Add tests:

```rust
observed_message_maps_canonical_fields
http_fetch_temp_messages_queries_session_with_sync
fake_adapter_records_fetch_session_ids
```

Required assertions:

- `ObservedMessage` maps `id`, `sessionId`, `providerInstanceId`, `observedAt`, `sender`, `subject`, `textBody`, and raw JSON.
- HTTP adapter calls `/mail/query/observed-messages?sessionId=session_1&sync=true&newestFirst=true`.
- Fake adapter records fetched session ids.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml observed_message_maps_canonical_fields
cargo test --manifest-path src-tauri/Cargo.toml http_fetch_temp_messages_queries_session_with_sync
cargo test --manifest-path src-tauri/Cargo.toml fake_adapter_records_fetch_session_ids
```

Expected before implementation: tests fail because observed-message models and `fetch_temp_messages` do not exist.

- [x] **Step 2: Implement canonical fetch models and trait method**

Add:

```rust
pub struct FetchTempMessagesRequest {
    pub easyemail_mailbox_id: String,
    pub force_sync: bool,
    pub limit: Option<usize>,
}

pub struct EasyEmailObservedMessage {
    pub id: String,
    pub session_id: String,
    pub provider_instance_id: String,
    pub observed_at: String,
    pub sender: Option<String>,
    pub subject: Option<String>,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    pub raw_json: serde_json::Value,
}
```

Extend `EasyEmailAdapter`:

```rust
fn fetch_temp_messages(
    &self,
    settings: &EasyEmailConnectionSettings,
    request: &FetchTempMessagesRequest,
) -> Result<Vec<EasyEmailObservedMessage>, AppError>;
```

- [x] **Step 3: Implement fake and HTTP fetch**

HTTP route:

```text
GET /mail/query/observed-messages?sessionId=<id>&sync=<true|false>&newestFirst=true&limit=<optional>
```

Response:

```json
{ "messages": [ ... ] }
```

- [x] **Step 4: Verify adapter tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml observed_message_maps_canonical_fields
cargo test --manifest-path src-tauri/Cargo.toml http_fetch_temp_messages_queries_session_with_sync
cargo test --manifest-path src-tauri/Cargo.toml fake_adapter_records_fetch_session_ids
```

Expected: each command reports pass.

- [x] **Step 5: Commit adapter fetch**

Run:

```powershell
git add src-tauri/src/easyemail
git commit -m "feat: fetch easyemail observed messages"
```

---

## Task 2: Message persistence and anonymous query

**Files:**
- Modify: `src-tauri/src/domain/message.rs`
- Modify: `src-tauri/src/storage/message_repository.rs`
- Modify: `src-tauri/src/storage/temp_mailbox_repository.rs`

- [x] **Step 1: Write failing repository tests**

Add tests:

```rust
fetch_temp_messages_inserts_messages_and_sources
fetch_temp_messages_is_idempotent
anonymous_message_query_excludes_upgraded_temp_mailbox
```

Required assertions:

- Saving a fetched EasyEmail observed message creates one `messages` row and one `message_sources` row.
- Re-saving the same EasyEmail observed message for the same temp mailbox inserts zero new rows.
- Anonymous query returns messages for `visibility_state='anonymous'` only and excludes upgraded temp mailbox messages.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml fetch_temp_messages_inserts_messages_and_sources
cargo test --manifest-path src-tauri/Cargo.toml fetch_temp_messages_is_idempotent
cargo test --manifest-path src-tauri/Cargo.toml anonymous_message_query_excludes_upgraded_temp_mailbox
```

Expected before implementation: tests fail because repository helpers and anonymous query do not exist.

- [x] **Step 2: Implement temp source and idempotent save helpers**

Add to `message_repository.rs`:

```rust
pub struct PersistObservedMessageInput { ... }
pub struct PersistObservedMessagesResult { pub fetched_count: usize, pub inserted_count: usize }
pub fn ensure_easyemail_temp_source(connection: &Connection, temp_mailbox: &TempMailboxRow, now: &str) -> Result<String>;
pub fn persist_observed_messages(connection: &Connection, temp_mailbox: &TempMailboxRow, source_id: &str, messages: &[EasyEmailObservedMessage], now: &str) -> Result<PersistObservedMessagesResult>;
```

Rules:

- Use `message_sources(temp_mailbox_id, easyemail_message_id)` as the dedupe key.
- For new messages, create `messages` and `message_sources`.
- Store EasyEmail observed `id` into `message_sources.easyemail_message_id`.
- Use received address from temp mailbox email.

- [x] **Step 3: Implement anonymous message query**

Add:

```rust
pub struct AnonymousMessageRow { ... }
pub fn list_anonymous_messages(connection: &Connection) -> Result<Vec<AnonymousMessageRow>>;
```

Query must join `messages`, `message_sources`, and `temp_mailboxes` and filter:

```sql
temp_mailboxes.visibility_state = 'anonymous'
AND messages.deleted_at IS NULL
```

Return rows with `message_id`, `temp_mailbox_id`, `received_address`, `provider_label`, `subject`, `from_address`, `snippet`, `observed_at`, and `lifecycle_state`.

- [x] **Step 4: Verify repository tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml fetch_temp_messages_inserts_messages_and_sources
cargo test --manifest-path src-tauri/Cargo.toml fetch_temp_messages_is_idempotent
cargo test --manifest-path src-tauri/Cargo.toml anonymous_message_query_excludes_upgraded_temp_mailbox
```

Expected: each command reports pass.

- [x] **Step 5: Commit persistence**

Run:

```powershell
git add src-tauri/src/domain/message.rs src-tauri/src/storage/message_repository.rs src-tauri/src/storage/temp_mailbox_repository.rs
git commit -m "feat: persist anonymous temp messages"
```

---

## Task 3: Refresh service orchestration

**Files:**
- Modify: `src-tauri/src/services/easyemail_service.rs`
- Modify: `src-tauri/src/storage/temp_mailbox_repository.rs`

- [x] **Step 1: Write failing service tests**

Add tests:

```rust
refresh_anonymous_fetches_only_active_anonymous_mailboxes
expired_temp_mailbox_is_skipped_unless_forced
```

Required assertions:

- Refresh-all fetches active anonymous temp mailboxes only.
- Upgraded, archived, and expired temp mailboxes are skipped by refresh-all.
- Refresh-one skips expired mailbox unless `force=true`.
- Forced refresh on expired mailbox fetches and persists messages without deleting history.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml refresh_anonymous_fetches_only_active_anonymous_mailboxes
cargo test --manifest-path src-tauri/Cargo.toml expired_temp_mailbox_is_skipped_unless_forced
```

Expected before implementation: tests fail because service refresh functions do not exist.

- [x] **Step 2: Implement refresh requests/results**

Add:

```rust
pub struct TempRefreshMailboxRequest { pub temp_mailbox_id: String, pub api_token: Option<String>, pub force: bool }
pub struct TempRefreshAnonymousRequest { pub api_token: Option<String> }
pub struct TempRefreshResult { pub fetched_count: usize, pub inserted_count: usize, pub skipped_count: usize, pub refreshed_mailbox_ids: Vec<String>, pub skipped_mailbox_ids: Vec<String> }
```

- [x] **Step 3: Implement refresh service functions**

Add:

```rust
pub fn refresh_temp_mailbox<A: EasyEmailAdapter>(connection: &Connection, adapter: &A, request: TempRefreshMailboxRequest, now: String) -> Result<TempRefreshResult, AppError>;
pub fn refresh_anonymous_temp_mailboxes<A: EasyEmailAdapter>(connection: &Connection, adapter: &A, request: TempRefreshAnonymousRequest, now: String) -> Result<TempRefreshResult, AppError>;
```

Rules:

- Load saved EasyEmail service URL and one-shot token.
- Skip temp mailboxes with no `easyemail_mailbox_id`.
- Skip non-anonymous temp mailboxes unless forced single-refresh.
- Skip `expired`, `history_only`, `provider_unavailable`, and `receive_unavailable` unless forced.
- Mark `lease_expires_at <= now` as `expired` before deciding skip.
- Persist fetched messages idempotently.
- Update temp mailbox `last_fetch_at`, `last_success_at`, and `updated_at` on successful refresh.

- [x] **Step 4: Verify service tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml refresh_anonymous_fetches_only_active_anonymous_mailboxes
cargo test --manifest-path src-tauri/Cargo.toml expired_temp_mailbox_is_skipped_unless_forced
```

Expected: each command reports pass.

- [x] **Step 5: Commit service**

Run:

```powershell
git add src-tauri/src/services/easyemail_service.rs src-tauri/src/storage/temp_mailbox_repository.rs
git commit -m "feat: refresh anonymous temp mailboxes"
```

---

## Task 4: Commands and UI

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Write failing command DTO tests**

Add tests:

```rust
anonymous_message_row_maps_to_command_dto
refresh_result_maps_to_command_dto
```

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml anonymous_message_row_maps_to_command_dto
cargo test --manifest-path src-tauri/Cargo.toml refresh_result_maps_to_command_dto
```

Expected before implementation: tests fail because command DTO helpers do not exist.

- [x] **Step 2: Implement Tauri commands**

Register:

```rust
temp_refresh_mailbox
temp_refresh_anonymous
message_list
```

`message_list` accepts:

```rust
pub struct MessageListCommandRequest { pub scope: String }
```

For this phase, support only `scope = "anonymous"` and return a validation error for any other scope.

- [x] **Step 3: Implement UI refresh and anonymous list**

Extend the current UI:

- Add "Refresh anonymous mail" button.
- Add per-temp mailbox refresh button.
- Add anonymous message list under the temp mailbox section.
- Each row shows sender, subject, snippet, real received temporary address, provider, time, and lifecycle state.

- [x] **Step 4: Verify command/UI compile**

Run:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both pass.

- [x] **Step 5: Commit commands and UI**

Run:

```powershell
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/App.tsx src/App.css
git commit -m "feat: show anonymous temp messages"
```

---

## Task 5: Full verification and tracker closeout

**Files:**
- Modify: `docs/progress/MASTER.md`
- Modify: `docs/progress/phase-1-core-schema.md`
- Modify: `docs/progress/phase-3-temp-fetch-anonymous.md`
- Modify: `docs/superpowers/plans/2026-06-12-easyemailam-temp-fetch-anonymous.md`

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

- `docs/progress/phase-3-temp-fetch-anonymous.md`: mark all Phase 3 tasks complete with evidence.
- `docs/progress/phase-1-core-schema.md`: mark anonymous aggregation query complete.
- `docs/progress/MASTER.md`: Phase 1 becomes 8/8, Phase 3 becomes 7/7, active phase becomes Phase 4.

- [x] **Step 3: Mark this plan complete**

Change all plan checkboxes to `- [x]` after evidence exists and append an execution record containing:

- Red test evidence.
- Targeted green test evidence.
- Full verification output summary.
- Commit hashes.
- Remaining phases.

- [x] **Step 4: Commit closeout**

Run:

```powershell
git add docs/progress docs/superpowers/plans/2026-06-12-easyemailam-temp-fetch-anonymous.md
git commit -m "docs: mark temp fetch phase executed"
git status --short --branch
```

Expected final status:

```text
## foundation
```

---

## Execution record

Plan execution status: complete.

### Red evidence observed before implementation

- Adapter tests failed before `EasyEmailObservedMessage`, `FetchTempMessagesRequest`, `with_observed_messages`, and `fetch_temp_messages` existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml observed_message_maps_canonical_fields`
  - `cargo test --manifest-path src-tauri/Cargo.toml fake_adapter_records_fetch_session_ids`
  - `cargo test --manifest-path src-tauri/Cargo.toml http_fetch_temp_messages_queries_session_with_sync`
- Repository tests failed before `ensure_easyemail_temp_source`, `persist_observed_messages`, and `list_anonymous_messages` existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml fetch_temp_messages_inserts_messages_and_sources`
  - `cargo test --manifest-path src-tauri/Cargo.toml fetch_temp_messages_is_idempotent`
  - `cargo test --manifest-path src-tauri/Cargo.toml anonymous_message_query_excludes_upgraded_temp_mailbox`
- Service tests failed before refresh request/result types and refresh service methods existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml refresh_anonymous_fetches_only_active_anonymous_mailboxes`
  - `cargo test --manifest-path src-tauri/Cargo.toml expired_temp_mailbox_is_skipped_unless_forced`
- Command DTO tests failed before command mapping helpers existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml anonymous_message_row_maps_to_command_dto`
  - `cargo test --manifest-path src-tauri/Cargo.toml refresh_result_maps_to_command_dto`

### Targeted green evidence

The targeted tests above passed after implementation:

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

### Full verification evidence

- `npm run verify` passed:
  - `npm run build` passed.
  - `cargo fmt` passed.
  - `cargo test` passed with 36 tests.
  - `cargo check` passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

### Commits

- `34a3cc6 docs: plan temp fetch phase`
- `67370e5 feat: fetch easyemail observed messages`
- `27b3134 feat: persist anonymous temp messages`
- `18b9da9 feat: refresh anonymous temp mailboxes`
- `5402d98 feat: show anonymous temp messages`
- `543bbaf style: apply rustfmt after temp fetch phase`

### Remaining phases

- Phase 0 still has EventBus and logging skeleton gaps.
- Phase 4 remains: verification codes and waiting mode.
- Phase 5 remains: promote temporary mailbox.
- Phase 6 remains: normal IMAP basics.
- Phase 7 remains: SMTP and send queue.
- Phase 8 remains: Agent mailbox MVP.
