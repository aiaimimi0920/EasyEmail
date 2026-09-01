# EasyEmail Adapter and Temp Mailbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` / `- [x]`) syntax for tracking.

**Goal:** Build Milestone 2 from the approved EasyEmailAM spec: configure an EasyEmail service URL, test the connection, create temporary mailboxes through an EasyEmail adapter, persist them as anonymous temp mailboxes, and expose a minimal UI.

**Architecture:** EasyEmailAM keeps EasyEmail provider logic outside the app. Rust owns the adapter boundary, service orchestration, SQLite persistence, redacted errors, and Tauri DTOs; React only edits settings and invokes commands. The first adapter slice uses blocking HTTP plus fake adapters for tests, and stores only the EasyEmail service URL in SQLite; API tokens are accepted only as one-shot command inputs until a real secret vault exists.

**Tech Stack:** Tauri 2, React 19, TypeScript, Rust 1.95, rusqlite, serde_json, uuid, ureq blocking HTTP, SQLite `app_settings` and `temp_mailboxes`.

---

## Scope and source facts

This plan implements only `docs/superpowers/specs/2026-06-11-easyemailam-design.md` Milestone 2:

```text
EasyEmailAdapter trait
HTTP adapter
Fake adapter
settings_test_easyemail
temp_create_mailbox
temp_list_mailboxes
basic temp mailbox UI
```

Verified EasyEmail API facts from sibling repo `C:\Users\Public\nas_home\AI\GameEditor\EasyEmail`:

- `GET /mail/catalog` returns `{ "catalog": EasyEmailCatalog }`.
- `POST /mail/mailboxes/open` accepts a `VerificationMailboxRequest` and returns `{ "result": VerificationMailboxOpenResult }`.
- The TypeScript client sets `Authorization: Bearer <apiKey>` only when an API key is provided.
- `VerificationMailboxOpenResult.result.session` contains `id`, `providerTypeKey`, `providerInstanceId`, `emailAddress`, `mailboxRef`, `status`, `createdAt`, and optional `expiresAt`.
- `VerificationMailboxOpenResult.result.instance` contains `id`, `providerTypeKey`, and `displayName`.

Milestone 2 explicitly does not implement message fetching, verification-code extraction, mailbox promotion, IMAP, SMTP, OAuth, or a persistent secret vault.

Security rule for this phase:

```text
Persist easyemail.service_url in SQLite.
Do not persist API token plaintext in SQLite.
Allow optional one-shot API token on test/create command calls only.
Never include one-shot API token in AppError metadata, technical messages, UI state dumps, or plan execution logs.
```

## File structure

Create or modify these files:

```text
src-tauri/Cargo.toml
src-tauri/src/lib.rs
src-tauri/src/error.rs
src-tauri/src/commands.rs
src-tauri/src/domain/temp_mailbox.rs
src-tauri/src/easyemail/mod.rs
src-tauri/src/easyemail/models.rs
src-tauri/src/easyemail/adapter.rs
src-tauri/src/easyemail/fake.rs
src-tauri/src/easyemail/http.rs
src-tauri/src/services/mod.rs
src-tauri/src/services/easyemail_service.rs
src-tauri/src/storage/mod.rs
src-tauri/src/storage/settings_repository.rs
src-tauri/src/storage/temp_mailbox_repository.rs
src/App.tsx
src/App.css
docs/superpowers/plans/2026-06-12-easyemailam-easyemail-adapter.md
```

Responsibility boundaries:

- `easyemail/models.rs`: canonical request/response models owned by EasyEmailAM.
- `easyemail/adapter.rs`: trait boundary and shared mapping helpers.
- `easyemail/http.rs`: HTTP-only adapter that knows EasyEmail route shapes.
- `easyemail/fake.rs`: deterministic test adapter and failure adapter.
- `services/easyemail_service.rs`: settings validation, connection test orchestration, and temp mailbox creation persistence.
- `storage/settings_repository.rs`: JSON-backed `app_settings` access for non-secret EasyEmail settings.
- `storage/temp_mailbox_repository.rs`: temp mailbox row insert/list/get with canonical EasyEmail fields.
- `commands.rs`: Tauri command DTO boundary and `AppError -> ErrorDto` conversion.
- `App.tsx` / `App.css`: minimal human UI for service URL, one-shot token, connection test, temp creation, and temp mailbox list.

---

## Task 1: Baseline and plan checkpoint

**Files:**
- Read: `docs/superpowers/specs/2026-06-11-easyemailam-design.md`
- Create: `docs/superpowers/plans/2026-06-12-easyemailam-easyemail-adapter.md`

- [x] **Step 1: Verify clean branch and baseline**

Run:

```powershell
git status --short --branch
npm run verify
```

Expected:

```text
## foundation
13 passed; 0 failed
cargo check exit 0
```

- [x] **Step 2: Save this plan**

Run:

```powershell
Test-Path -LiteralPath 'docs\superpowers\plans\2026-06-12-easyemailam-easyemail-adapter.md'
```

Expected:

```text
True
```

- [x] **Step 3: Commit the plan checkpoint**

Run:

```powershell
git add docs/superpowers/plans/2026-06-12-easyemailam-easyemail-adapter.md
git commit -m "docs: plan easyemail adapter phase"
```

Expected:

```text
[foundation <sha>] docs: plan easyemail adapter phase
```

---

## Task 2: Settings repository and validation

**Files:**
- Create: `src-tauri/src/storage/settings_repository.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Create service file later referenced by this task: `src-tauri/src/services/easyemail_service.rs`

- [x] **Step 1: Write failing repository and validation tests**

Add tests named:

```rust
settings_repository_saves_and_loads_easyemail_url
blank_easyemail_service_url_is_rejected
invalid_easyemail_service_url_is_rejected
```

The first test must use an in-memory SQLite database and assert that saving `http://127.0.0.1:8080/` loads `http://127.0.0.1:8080`. The validation tests must assert `AppError.code == "easyemail_service_url_invalid"` and `ActionRequired::EditSettings`.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml settings_repository_saves_and_loads_easyemail_url blank_easyemail_service_url_is_rejected invalid_easyemail_service_url_is_rejected
```

Expected: the tests fail because repository/service functions do not exist.

- [x] **Step 2: Implement non-secret EasyEmail settings**

Implement:

```rust
pub const EASYEMAIL_SETTINGS_KEY: &str = "easyemail.connection";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EasyEmailStoredSettings {
    pub service_url: Option<String>,
}

pub fn load_easyemail_settings(connection: &Connection) -> Result<EasyEmailStoredSettings>;
pub fn save_easyemail_service_url(connection: &Connection, service_url: &str, now: &str) -> Result<()>;
```

Validation in `services/easyemail_service.rs` must trim trailing slashes and accept only `http://` or `https://`.

- [x] **Step 3: Verify green**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml settings_repository_saves_and_loads_easyemail_url blank_easyemail_service_url_is_rejected invalid_easyemail_service_url_is_rejected
```

Expected:

```text
3 passed; 0 failed
```

- [x] **Step 4: Commit settings**

Run:

```powershell
git add src-tauri/src/storage/mod.rs src-tauri/src/storage/settings_repository.rs src-tauri/src/services
git commit -m "feat: add easyemail settings storage"
```

---

## Task 3: EasyEmail adapter trait, fake adapter, HTTP adapter

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/easyemail/mod.rs`
- Create: `src-tauri/src/easyemail/models.rs`
- Create: `src-tauri/src/easyemail/adapter.rs`
- Create: `src-tauri/src/easyemail/fake.rs`
- Create: `src-tauri/src/easyemail/http.rs`

- [x] **Step 1: Write failing adapter tests**

Add tests named:

```rust
easyemail_health_success_maps_to_dto
http_easyemail_health_success_maps_catalog
easyemail_unreachable_maps_to_retryable_error
http_open_mailbox_maps_canonical_fields
```

Required behavior:

- Catalog provider count maps from `catalog.providerTypes.length`.
- HTTP non-connectivity maps to `ErrorCategory::Network`, `retryable = true`, `ActionRequired::CheckEasyEmailConnection`.
- Open result maps canonical fields from `result.session` and `result.instance`.
- Raw provider snapshot remains a JSON value and does not drive core selection logic.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml easyemail_health_success_maps_to_dto http_easyemail_health_success_maps_catalog easyemail_unreachable_maps_to_retryable_error http_open_mailbox_maps_canonical_fields
```

Expected: tests fail because the adapter modules do not exist.

- [x] **Step 2: Add `ureq` and canonical models**

Add to `src-tauri/Cargo.toml`:

```toml
ureq = { version = "2.12.1", features = ["json"] }
```

Define:

```rust
pub struct EasyEmailConnectionSettings { pub service_url: String, pub api_token: Option<String> }
pub struct EasyEmailHealth { pub reachable: bool, pub provider_count: usize, pub auth_status: String, pub capabilities_summary: String }
pub struct CreateTempMailboxRequest { pub target_service: Option<String>, pub provider_selection: Option<String>, pub domain_selection: Option<String>, pub local_part: Option<String>, pub note: Option<String> }
pub struct EasyEmailTempMailbox { pub email_address: String, pub provider_id: String, pub provider_label: String, pub easyemail_mailbox_id: Option<String>, pub lease_expires_at: Option<String>, pub raw_provider_snapshot_json: serde_json::Value }
pub trait EasyEmailAdapter { fn health_check(&self, settings: &EasyEmailConnectionSettings) -> Result<EasyEmailHealth, AppError>; fn create_temp_mailbox(&self, settings: &EasyEmailConnectionSettings, request: &CreateTempMailboxRequest) -> Result<EasyEmailTempMailbox, AppError>; }
```

- [x] **Step 3: Implement fake adapter and HTTP adapter**

HTTP adapter routes:

```text
GET  {service_url}/mail/catalog
POST {service_url}/mail/mailboxes/open
```

Open payload:

```json
{
  "hostId": "easyemailam",
  "provisionMode": "auto-create-if-missing",
  "bindingMode": "shared-instance",
  "requestedDomain": "...optional...",
  "requestedLocalPart": "...optional...",
  "providerTypeKey": "...optional...",
  "metadata": { "note": "...optional..." }
}
```

Error mapping:

```text
401/403 -> auth, edit settings, not retryable
429     -> rate_limit, wait, retryable
5xx     -> provider/network, retry, retryable
transport -> network, check EasyEmail connection, retryable
```

Never put `api_token` into error metadata.

- [x] **Step 4: Verify green**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml easyemail_health_success_maps_to_dto http_easyemail_health_success_maps_catalog easyemail_unreachable_maps_to_retryable_error http_open_mailbox_maps_canonical_fields
```

Expected:

```text
4 passed; 0 failed
```

- [x] **Step 5: Commit adapters**

Run:

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/easyemail
git commit -m "feat: add easyemail adapter boundary"
```

---

## Task 4: Temp mailbox service and persistence

**Files:**
- Modify: `src-tauri/src/domain/temp_mailbox.rs`
- Modify: `src-tauri/src/storage/temp_mailbox_repository.rs`
- Modify: `src-tauri/src/services/easyemail_service.rs`

- [x] **Step 1: Write failing service tests**

Add required spec tests:

```rust
create_temp_mailbox_saves_canonical_fields
create_temp_mailbox_stores_raw_snapshot_without_core_dependency
provider_rate_limit_returns_rate_limit_error
easyemail_token_is_not_present_in_error_dto_metadata
```

Required behavior:

- Created temp mailbox has `visibility_state = anonymous`.
- `provider_id`, `provider_label`, `easyemail_mailbox_id`, `lease_expires_at`, and raw snapshot persist to SQLite.
- Rate-limit failure returns `ErrorCategory::RateLimit`, `ActionRequired::Wait`, and `retryable = true`.
- A one-shot token in settings/request does not appear in `ErrorDto.metadata` or `technical_message`.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml create_temp_mailbox_saves_canonical_fields create_temp_mailbox_stores_raw_snapshot_without_core_dependency provider_rate_limit_returns_rate_limit_error easyemail_token_is_not_present_in_error_dto_metadata
```

Expected: tests fail because service persistence behavior is incomplete.

- [x] **Step 2: Extend temp mailbox domain and repository**

Add these fields to `TempMailbox` and `TempMailboxRow`:

```rust
pub domain: Option<String>,
pub local_part: Option<String>,
pub easyemail_mailbox_id: Option<String>,
pub lease_expires_at: Option<String>,
pub raw_provider_snapshot_json: String,
```

`insert_temp_mailbox` must write the existing `temp_mailboxes` columns already present in `0001_foundation.sql`.

Add:

```rust
pub fn list_temp_mailboxes(connection: &Connection) -> Result<Vec<TempMailboxRow>>;
```

- [x] **Step 3: Implement service orchestration**

Add:

```rust
pub fn update_easyemail_settings(connection: &Connection, service_url: String, now: String) -> Result<EasyEmailStoredSettings, AppError>;
pub fn test_easyemail_connection<A: EasyEmailAdapter>(connection: &Connection, adapter: &A, request: EasyEmailConnectionTestRequest) -> Result<EasyEmailHealth, AppError>;
pub fn create_temp_mailbox<A: EasyEmailAdapter>(connection: &Connection, adapter: &A, request: CreateTempMailboxServiceRequest, now: String) -> Result<TempMailbox, AppError>;
```

Creation must load saved service URL, attach only the one-shot token to adapter settings, call `adapter.create_temp_mailbox`, convert the canonical result to a `TempMailbox`, and insert it.

- [x] **Step 4: Verify green**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml create_temp_mailbox_saves_canonical_fields create_temp_mailbox_stores_raw_snapshot_without_core_dependency provider_rate_limit_returns_rate_limit_error easyemail_token_is_not_present_in_error_dto_metadata
```

Expected:

```text
4 passed; 0 failed
```

- [x] **Step 5: Commit service**

Run:

```powershell
git add src-tauri/src/domain/temp_mailbox.rs src-tauri/src/storage/temp_mailbox_repository.rs src-tauri/src/services
git commit -m "feat: persist easyemail temp mailboxes"
```

---

## Task 5: Tauri commands and minimal UI

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Write failing command boundary test or compile test**

Add Rust tests for command DTO conversion helpers where practical, and rely on `cargo check` for Tauri command registration. Add TypeScript types in `App.tsx` before wiring UI calls.

Run:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected before implementation: build/check fail because commands are not registered or frontend invokes missing command names.

- [x] **Step 2: Implement Tauri commands**

Register:

```rust
settings_get_easyemail
settings_update_easyemail
settings_test_easyemail
temp_create_mailbox
temp_list_mailboxes
```

Command DTOs must return only stable fields:

```text
service_url, has_api_token=false
reachable, provider_count, auth_status, capabilities_summary
id, email_address, provider_id, provider_label, visibility_state, lifecycle_state, easyemail_mailbox_id, lease_expires_at, created_at, updated_at
```

- [x] **Step 3: Implement minimal React UI**

UI sections:

```text
Foundation status
EasyEmail connection settings
One-shot API token input, marked "not stored"
Test connection button
Create temporary mailbox form with optional target service and note
Temporary mailbox list
Redacted/user-readable error panel
```

TypeScript must use `unknown` narrowing for caught errors and must not use `any`.

- [x] **Step 4: Verify UI and command compilation**

Run:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected:

```text
tsc exit 0
vite build exit 0
cargo check exit 0
```

- [x] **Step 5: Commit commands and UI**

Run:

```powershell
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/App.tsx src/App.css
git commit -m "feat: wire easyemail temp mailbox ui"
```

---

## Task 6: Full verification and plan closeout

**Files:**
- Modify: `docs/superpowers/plans/2026-06-12-easyemailam-easyemail-adapter.md`

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

- [x] **Step 2: Mark this plan complete**

Change every `- [x]` checkbox in this plan to `- [x]` only after the matching work has evidence. Append an execution record with:

```text
Baseline command and result
Targeted test commands and result
Full verification commands and result
Commit hashes
Known remaining scope intentionally deferred to Milestone 3+
```

- [x] **Step 3: Commit plan closeout**

Run:

```powershell
git add docs/superpowers/plans/2026-06-12-easyemailam-easyemail-adapter.md
git commit -m "docs: mark easyemail adapter phase executed"
git status --short --branch
```

Expected:

```text
## foundation
```

---

## Execution record

Completed on 2026-06-12 on branch `foundation`.

### Baseline evidence

```text
git status --short --branch
## foundation

npm run verify
13 passed; 0 failed
cargo check exit 0
```

### TDD red evidence

```text
cargo test --manifest-path src-tauri/Cargo.toml easyemail_service_url
FAILED before implementation with missing EasyEmailStoredSettings, validate_easyemail_service_url, save_easyemail_service_url, and load_easyemail_settings.

cargo test --manifest-path src-tauri/Cargo.toml easyemail
FAILED before implementation with missing EasyEmailAdapter, EasyEmailConnectionSettings, FakeEasyEmailAdapter, HttpEasyEmailAdapter, and EasyEmailTempMailbox.

cargo test --manifest-path src-tauri/Cargo.toml create_temp_mailbox
FAILED before implementation with missing CreateTempMailboxServiceRequest, create_temp_mailbox, and canonical TempMailboxRow fields.

cargo test --manifest-path src-tauri/Cargo.toml temp_mailbox_row_maps_to_command_dto
FAILED before implementation with missing temp_mailbox_row_to_dto.
```

### Targeted green evidence

```text
cargo test --manifest-path src-tauri/Cargo.toml easyemail_service_url
2 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml settings_repository_saves_and_loads_easyemail_url
1 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml easyemail
8 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml create_temp_mailbox
2 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml rate_limit
1 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml token_is_not_present
1 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml temp_mailbox_row_maps_to_command_dto
1 passed; 0 failed

npm run build; cargo check --manifest-path src-tauri/Cargo.toml
tsc exit 0; vite build exit 0; cargo check exit 0
```

### Full verification evidence

```text
npm run verify
build passed
cargo fmt passed
cargo test: 26 passed; 0 failed
cargo check passed

cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
Finished dev profile; exit 0
```

### Commits

```text
7d22176 docs: plan easyemail adapter phase
a094c56 feat: add easyemail settings storage
6c8f9a9 feat: add easyemail adapter boundary
7f9eacd feat: persist easyemail temp mailboxes
b5daee1 feat: wire easyemail temp mailbox ui
a86a91c fix: satisfy easyemail adapter verification
```

### Delivered scope

- Added non-secret EasyEmail service URL storage in SQLite `app_settings`.
- Added optional one-shot API token handling for connection test and mailbox creation without persisting the token.
- Added `EasyEmailAdapter` trait, fake adapter, and blocking HTTP adapter for `/mail/catalog` and `/mail/mailboxes/open`.
- Added canonical temp mailbox mapping and persistence of provider/session fields plus raw provider snapshot JSON.
- Added Tauri commands: `settings_get_easyemail`, `settings_update_easyemail`, `settings_test_easyemail`, `temp_create_mailbox`, and `temp_list_mailboxes`.
- Added a minimal React UI for service URL configuration, one-shot token input, connection testing, temporary mailbox creation, and temp mailbox listing.

### Deferred intentionally to Milestone 3+

- Fetching temporary mailbox messages.
- Anonymous mailbox message aggregation.
- Verification-code extraction and waiting mode.
- Temporary mailbox promotion UI beyond existing foundation repository invariant.
- Persistent keychain-backed secret vault.
