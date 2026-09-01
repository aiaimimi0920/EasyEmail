# Verification Codes and Waiting Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` / `- [x]`) syntax for tracking.

**Goal:** Build Milestone 4 from the approved EasyEmailAM spec: extract verification codes from received messages, persist/query them with source traceability, support waiting-mode polling, and expose copy-code UI.

**Architecture:** Keep extraction rule-based and local. Message fetch remains owned by the EasyEmail refresh service, but refresh calls the verification service only with newly inserted message ids so repeated fetches do not create duplicate code records. Tauri commands are DTO glue only; repositories own SQL; services own product policy; the React UI owns the visible polling loop and copy action.

**Tech Stack:** Rust 2021, rusqlite, serde/serde_json, Tauri 2 commands, React 19, TypeScript, Vite.

---

## File structure

- Modify `src-tauri/src/domain/verification.rs`
  - Add extraction input/output structs.
  - Implement lightweight 4-8 digit code extraction from subject/body text with verification keywords.
  - Derive issuer hints from sender/domain and preserve target-service hints when provided.
- Modify `src-tauri/src/redaction.rs`
  - Redact verification-code-like values from log/diagnostic text when verification keywords are present.
  - Redact JSON metadata fields that explicitly carry verification codes.
- Create `src-tauri/src/storage/verification_repository.rs`
  - Persist extracted codes idempotently by `(message_id, code)`.
  - Load message/source context for reclassification.
  - List recent codes with optional `temp_mailbox_id` filter and source traceability.
- Modify `src-tauri/src/storage/mod.rs`
  - Export `verification_repository`.
- Modify `src-tauri/src/storage/message_repository.rs`
  - Include `inserted_message_ids` in `PersistObservedMessagesResult`.
  - Keep existing counts stable.
- Create `src-tauri/src/services/verification_service.rs`
  - Reclassify one message.
  - Classify newly inserted messages after temp fetch.
  - List recent codes.
  - Poll one temp mailbox by refreshing and returning the latest detected code.
- Modify `src-tauri/src/services/mod.rs`
  - Export `verification_service`.
- Modify `src-tauri/src/services/easyemail_service.rs`
  - Call `classify_new_messages` after idempotent temp-message persistence.
  - Return existing refresh counts unchanged.
- Modify `src-tauri/src/commands.rs`
  - Add DTOs and commands:
    - `verification_list_recent`
    - `verification_reclassify_message`
    - `verification_poll_temp_mailbox`
- Modify `src-tauri/src/lib.rs`
  - Register the new commands.
- Modify `src/App.tsx`
  - Add wait-for-code checkbox to temporary mailbox creation.
  - Add recent-code list with code, issuer, received address, source message id, received/extracted time, confidence, copy action.
  - Poll the selected waiting mailbox until a code is found, mailbox expires, or the user stops waiting.
- Modify `src/App.css`
  - Style recent codes, waiting state, and copy actions.
- Modify progress/plan docs at closeout:
  - `docs/progress/MASTER.md`
  - `docs/progress/phase-4-verification-codes.md`
  - this plan file

---

## Task 1: Rule-based extraction and redaction

**Files:**
- Modify: `src-tauri/src/domain/verification.rs`
- Modify: `src-tauri/src/redaction.rs`

- [x] **Step 1: Write failing extractor/redaction tests**

Add tests in `src-tauri/src/domain/verification.rs`:

```rust
#[test]
fn extracts_common_6_digit_verification_code() {
    let input = VerificationExtractionInput {
        message_id: "msg_1".to_string(),
        account_scope: "anonymous".to_string(),
        received_address: "code@example.test".to_string(),
        subject: "Your verification code".to_string(),
        from_address: "noreply@example.test".to_string(),
        body_text: Some("Use 123456 to continue.".to_string()),
        body_html: None,
        target_service_hint: Some("github".to_string()),
        observed_at: "2026-06-12T00:10:00Z".to_string(),
    };

    let code = extract_verification_code(&input, "2026-06-12T00:11:00Z")
        .expect("verification code should be extracted");

    assert_eq!(code.message_id, "msg_1");
    assert_eq!(code.code, "123456");
    assert_eq!(code.received_address, "code@example.test");
    assert_eq!(code.target_service_hint, Some("github".to_string()));
    assert!(code.confidence >= 0.8);
}

#[test]
fn extracts_code_from_subject_or_body() {
    let subject_input = VerificationExtractionInput {
        message_id: "msg_subject".to_string(),
        account_scope: "anonymous".to_string(),
        received_address: "subject@example.test".to_string(),
        subject: "Login code: 654321".to_string(),
        from_address: "security@example.test".to_string(),
        body_text: None,
        body_html: None,
        target_service_hint: None,
        observed_at: "2026-06-12T00:10:00Z".to_string(),
    };
    let body_input = VerificationExtractionInput {
        message_id: "msg_body".to_string(),
        account_scope: "anonymous".to_string(),
        received_address: "body@example.test".to_string(),
        subject: "Confirm your sign in".to_string(),
        from_address: "security@example.test".to_string(),
        body_text: Some("Your one-time passcode is 778899.".to_string()),
        body_html: None,
        target_service_hint: None,
        observed_at: "2026-06-12T00:10:00Z".to_string(),
    };

    assert_eq!(
        extract_verification_code(&subject_input, "2026-06-12T00:11:00Z")
            .expect("subject code")
            .code,
        "654321"
    );
    assert_eq!(
        extract_verification_code(&body_input, "2026-06-12T00:11:00Z")
            .expect("body code")
            .code,
        "778899"
    );
}
```

Add test in `src-tauri/src/redaction.rs`:

```rust
#[test]
fn verification_code_not_logged_plain_by_default() {
    let text = redact_text("verification code is 123456");
    let metadata = redact_json(&serde_json::json!({
        "verification_code": "123456",
        "safe": "visible"
    }));

    assert!(!text.contains("123456"));
    assert_eq!(metadata["verification_code"], "[REDACTED]");
    assert_eq!(metadata["safe"], "visible");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml extracts_common_6_digit_verification_code
cargo test --manifest-path src-tauri/Cargo.toml extracts_code_from_subject_or_body
cargo test --manifest-path src-tauri/Cargo.toml verification_code_not_logged_plain_by_default
```

Expected before implementation: extractor tests fail because `VerificationExtractionInput` and `extract_verification_code` do not exist; redaction test fails because code-like values are not redacted.

- [x] **Step 3: Implement extraction and redaction**

Implement:

```rust
pub struct VerificationExtractionInput {
    pub message_id: String,
    pub account_scope: String,
    pub received_address: String,
    pub subject: String,
    pub from_address: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub target_service_hint: Option<String>,
    pub observed_at: String,
}

pub fn extract_verification_code(
    input: &VerificationExtractionInput,
    now: &str,
) -> Option<VerificationCode>
```

Rules:

- Scan subject first, then body text, then body HTML text.
- Accept digit groups with length 4 through 8.
- Prefer candidates near keywords: `verification`, `verify`, `code`, `otp`, `passcode`, `one-time`, `security`, `login`, `sign in`.
- For a single 6-digit candidate, accept even if only weak keywords are present.
- Set `issuer_hint` to the sender domain after `@` when present, otherwise the sender value.
- Set `confidence` to at least `0.90` when a keyword and 6-digit code are present, otherwise at least `0.70`.
- Set `extracted_at` from `now`.

Update `redaction.rs`:

- Treat keys containing `verification_code` or equal to `otp`, `passcode`, or `auth_code` as secret keys.
- When text contains verification keywords, replace 4-8 digit groups with `[REDACTED_CODE]`.

- [x] **Step 4: Run tests to verify they pass**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml extracts_common_6_digit_verification_code
cargo test --manifest-path src-tauri/Cargo.toml extracts_code_from_subject_or_body
cargo test --manifest-path src-tauri/Cargo.toml verification_code_not_logged_plain_by_default
```

Expected: each command reports pass.

- [x] **Step 5: Commit extraction/redaction**

Run:

```powershell
git add src-tauri/src/domain/verification.rs src-tauri/src/redaction.rs
git commit -m "feat: extract verification codes"
```

---

## Task 2: Verification-code repository and recent query

**Files:**
- Create: `src-tauri/src/storage/verification_repository.rs`
- Modify: `src-tauri/src/storage/mod.rs`

- [x] **Step 1: Write failing repository tests**

Add tests in `src-tauri/src/storage/verification_repository.rs`:

```rust
#[test]
fn associates_code_with_temp_mailbox_received_address() {
    let connection = test_connection();
    let message_id = seed_temp_message(
        &connection,
        "temp_1",
        "code@example.test",
        "Your verification code",
        "Use 123456 to continue.",
    );

    let context = load_message_for_verification(&connection, &message_id)
        .expect("load context")
        .expect("message context exists");
    let code = extract_verification_code(&context.to_extraction_input(), "2026-06-12T00:12:00Z")
        .expect("extract code");
    persist_verification_code(&connection, &code).expect("persist code");
    let rows = list_recent_verification_codes(
        &connection,
        RecentVerificationCodeFilter {
            temp_mailbox_id: None,
            limit: 10,
        },
    )
    .expect("list recent");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].code, "123456");
    assert_eq!(rows[0].received_address, "code@example.test");
    assert_eq!(rows[0].temp_mailbox_id, Some("temp_1".to_string()));
    assert_eq!(rows[0].message_id, message_id);
}

#[test]
fn recent_codes_can_filter_by_temp_mailbox() {
    let connection = test_connection();
    let first_message_id = seed_temp_message(
        &connection,
        "temp_1",
        "one@example.test",
        "Code 111111",
        "Use 111111.",
    );
    let second_message_id = seed_temp_message(
        &connection,
        "temp_2",
        "two@example.test",
        "Code 222222",
        "Use 222222.",
    );
    for message_id in [first_message_id, second_message_id] {
        let context = load_message_for_verification(&connection, &message_id)
            .expect("load context")
            .expect("message context exists");
        let code = extract_verification_code(&context.to_extraction_input(), "2026-06-12T00:12:00Z")
            .expect("extract code");
        persist_verification_code(&connection, &code).expect("persist code");
    }

    let rows = list_recent_verification_codes(
        &connection,
        RecentVerificationCodeFilter {
            temp_mailbox_id: Some("temp_2".to_string()),
            limit: 10,
        },
    )
    .expect("list recent");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].code, "222222");
    assert_eq!(rows[0].temp_mailbox_id, Some("temp_2".to_string()));
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml associates_code_with_temp_mailbox_received_address
cargo test --manifest-path src-tauri/Cargo.toml recent_codes_can_filter_by_temp_mailbox
```

Expected before implementation: tests fail because `verification_repository` functions/types do not exist.

- [x] **Step 3: Implement repository**

Add:

```rust
pub struct MessageVerificationContext {
    pub message_id: String,
    pub subject: String,
    pub from_address: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub received_address: String,
    pub account_scope: String,
    pub temp_mailbox_id: Option<String>,
    pub source_id: String,
    pub observed_at: String,
}

pub struct RecentVerificationCodeFilter {
    pub temp_mailbox_id: Option<String>,
    pub limit: usize,
}

pub struct RecentVerificationCodeRow {
    pub id: String,
    pub message_id: String,
    pub temp_mailbox_id: Option<String>,
    pub source_id: String,
    pub account_scope: String,
    pub received_address: String,
    pub code: String,
    pub issuer_hint: Option<String>,
    pub target_service_hint: Option<String>,
    pub confidence: f64,
    pub expires_at: Option<String>,
    pub extracted_at: String,
    pub subject: String,
    pub from_address: String,
    pub observed_at: String,
}
```

Functions:

- `load_message_for_verification(connection, message_id)`.
- `persist_verification_code(connection, code)`:
  - Select existing row by `(message_id, code)`.
  - Insert when absent.
  - Update `issuer_hint`, `target_service_hint`, `confidence`, `expires_at`, `extracted_at` when present.
- `list_recent_verification_codes(connection, filter)`:
  - Join `verification_codes`, `messages`, `message_sources`, and `temp_mailboxes`.
  - Filter by `temp_mailbox_id` when provided.
  - Order by `verification_codes.extracted_at DESC, verification_codes.id DESC`.
  - Clamp `limit` to `1..=100`, defaulting zero to 25.

- [x] **Step 4: Run repository tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml associates_code_with_temp_mailbox_received_address
cargo test --manifest-path src-tauri/Cargo.toml recent_codes_can_filter_by_temp_mailbox
```

Expected: each command reports pass.

- [x] **Step 5: Commit repository**

Run:

```powershell
git add src-tauri/src/storage/mod.rs src-tauri/src/storage/verification_repository.rs
git commit -m "feat: persist verification code records"
```

---

## Task 3: Verification service and fetch integration

**Files:**
- Create: `src-tauri/src/services/verification_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/easyemail_service.rs`
- Modify: `src-tauri/src/storage/message_repository.rs`

- [x] **Step 1: Write failing service tests**

Add tests:

```rust
#[test]
fn refresh_temp_mailbox_extracts_codes_for_inserted_messages() {
    let connection = test_connection();
    let temp = TempMailbox::from_easyemail(
        "code@example.test".to_string(),
        "mailtm".to_string(),
        "Mail.tm".to_string(),
        Some("session_code".to_string()),
        None,
        "{}".to_string(),
        "2026-06-12T00:00:00Z".to_string(),
    );
    insert_temp_mailbox(&connection, &temp).expect("insert temp");
    let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
        "session_code",
        vec![observed_message_for_service("observed_code", "session_code")],
    );

    refresh_temp_mailbox(
        &connection,
        &adapter,
        TempRefreshMailboxRequest {
            temp_mailbox_id: temp.id.clone(),
            api_token: None,
            force: false,
        },
        "2026-06-12T00:15:00Z".to_string(),
    )
    .expect("refresh temp");

    let rows = crate::storage::verification_repository::list_recent_verification_codes(
        &connection,
        crate::storage::verification_repository::RecentVerificationCodeFilter {
            temp_mailbox_id: Some(temp.id),
            limit: 10,
        },
    )
    .expect("list codes");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].code, "123456");
}
```

Add tests in `src-tauri/src/services/verification_service.rs`:

```rust
#[test]
fn reclassify_message_updates_existing_code() {
    let connection = test_connection();
    let message_id = seed_temp_message(&connection, "temp_1", "code@example.test", "Code 123456", "Use 123456.");

    let first = reclassify_message(
        &connection,
        VerificationReclassifyRequest {
            message_id: message_id.clone(),
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("first reclassify")
    .expect("code extracted");
    let second = reclassify_message(
        &connection,
        VerificationReclassifyRequest { message_id },
        "2026-06-12T00:11:00Z".to_string(),
    )
    .expect("second reclassify")
    .expect("code extracted");

    assert_eq!(first.code, "123456");
    assert_eq!(first.id, second.id);
    assert_eq!(second.extracted_at, "2026-06-12T00:11:00Z");
}

#[test]
fn wait_for_code_polling_reports_detected_code() {
    let connection = test_connection();
    let temp = seed_waiting_temp_mailbox(&connection, "session_wait");
    let adapter = FakeEasyEmailAdapter::healthy(1).with_observed_messages(
        "session_wait",
        vec![observed_message_for_service("observed_wait", "session_wait")],
    );

    let result = poll_temp_mailbox_for_code(
        &connection,
        &adapter,
        VerificationPollTempMailboxRequest {
            temp_mailbox_id: temp.id,
            api_token: None,
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("poll temp");

    assert!(result.detected_code.is_some());
    assert_eq!(result.refresh.inserted_count, 1);
    assert_eq!(result.detected_code.expect("code").code, "123456");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml refresh_temp_mailbox_extracts_codes_for_inserted_messages
cargo test --manifest-path src-tauri/Cargo.toml reclassify_message_updates_existing_code
cargo test --manifest-path src-tauri/Cargo.toml wait_for_code_polling_reports_detected_code
```

Expected before implementation: tests fail because the verification service and inserted-message ids are missing.

- [x] **Step 3: Implement service and refresh integration**

Changes:

- `PersistObservedMessagesResult` gains `inserted_message_ids: Vec<String>`.
- `persist_observed_messages` pushes each newly inserted `message_id`.
- `easyemail_service::refresh_temp_mailbox_row` calls:

```rust
crate::services::verification_service::classify_new_messages(
    connection,
    &persisted.inserted_message_ids,
    now,
)?;
```

- `verification_service.rs` exports:

```rust
pub struct VerificationReclassifyRequest { pub message_id: String }
pub struct VerificationListRecentRequest { pub temp_mailbox_id: Option<String>, pub limit: usize }
pub struct VerificationPollTempMailboxRequest { pub temp_mailbox_id: String, pub api_token: Option<String> }
pub struct VerificationPollResult { pub refresh: TempRefreshResult, pub detected_code: Option<RecentVerificationCodeRow> }

pub fn classify_new_messages(connection: &Connection, message_ids: &[String], now: &str) -> Result<Vec<RecentVerificationCodeRow>, AppError>
pub fn reclassify_message(connection: &Connection, request: VerificationReclassifyRequest, now: String) -> Result<Option<RecentVerificationCodeRow>, AppError>
pub fn list_recent_codes(connection: &Connection, request: VerificationListRecentRequest) -> Result<Vec<RecentVerificationCodeRow>, AppError>
pub fn poll_temp_mailbox_for_code<A: EasyEmailAdapter>(connection: &Connection, adapter: &A, request: VerificationPollTempMailboxRequest, now: String) -> Result<VerificationPollResult, AppError>
```

Policy:

- Missing message id returns validation error `verification_message_not_found`.
- Messages without code return `Ok(None)`.
- Polling refreshes one mailbox with `force=false`, reclassifies newly inserted messages through the refresh integration, then returns the newest code for that temp mailbox.
- No service error metadata contains the extracted full code.

- [x] **Step 4: Run service tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml refresh_temp_mailbox_extracts_codes_for_inserted_messages
cargo test --manifest-path src-tauri/Cargo.toml reclassify_message_updates_existing_code
cargo test --manifest-path src-tauri/Cargo.toml wait_for_code_polling_reports_detected_code
```

Expected: each command reports pass.

- [x] **Step 5: Commit service integration**

Run:

```powershell
git add src-tauri/src/services/mod.rs src-tauri/src/services/verification_service.rs src-tauri/src/services/easyemail_service.rs src-tauri/src/storage/message_repository.rs
git commit -m "feat: classify temp mailbox verification codes"
```

---

## Task 4: Tauri verification commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing command DTO tests**

Add tests in `src-tauri/src/commands.rs`:

```rust
#[test]
fn verification_code_row_maps_to_command_dto() {
    let row = recent_code_row_for_test();

    let dto = verification_code_row_to_dto(row);

    assert_eq!(dto.code, "123456");
    assert_eq!(dto.message_id, "msg_1");
    assert_eq!(dto.temp_mailbox_id, Some("temp_1".to_string()));
    assert_eq!(dto.received_address, "code@example.test");
    assert_eq!(dto.source_id, "src_1");
}

#[test]
fn verification_poll_result_maps_to_command_dto() {
    let result = VerificationPollResult {
        refresh: TempRefreshResult {
            fetched_count: 1,
            inserted_count: 1,
            skipped_count: 0,
            refreshed_mailbox_ids: vec!["temp_1".to_string()],
            skipped_mailbox_ids: Vec::new(),
        },
        detected_code: Some(recent_code_row_for_test()),
    };

    let dto = verification_poll_result_to_dto(result);

    assert_eq!(dto.refresh.inserted_count, 1);
    assert_eq!(dto.detected_code.expect("code").code, "123456");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml verification_code_row_maps_to_command_dto
cargo test --manifest-path src-tauri/Cargo.toml verification_poll_result_maps_to_command_dto
```

Expected before implementation: tests fail because command DTO helpers do not exist.

- [x] **Step 3: Implement commands and DTOs**

Add request DTOs:

```rust
pub struct VerificationListRecentCommandRequest {
    pub temp_mailbox_id: Option<String>,
    pub limit: Option<usize>,
}

pub struct VerificationReclassifyCommandRequest {
    pub message_id: String,
}

pub struct VerificationPollTempMailboxCommandRequest {
    pub temp_mailbox_id: String,
    pub api_token: Option<String>,
}
```

Add response DTOs:

```rust
pub struct VerificationCodeDto {
    pub id: String,
    pub message_id: String,
    pub temp_mailbox_id: Option<String>,
    pub source_id: String,
    pub account_scope: String,
    pub received_address: String,
    pub code: String,
    pub issuer_hint: Option<String>,
    pub target_service_hint: Option<String>,
    pub confidence: f64,
    pub expires_at: Option<String>,
    pub extracted_at: String,
    pub subject: String,
    pub from_address: String,
    pub observed_at: String,
}

pub struct VerificationPollDto {
    pub refresh: TempRefreshDto,
    pub detected_code: Option<VerificationCodeDto>,
}
```

Register commands:

- `verification_list_recent`
- `verification_reclassify_message`
- `verification_poll_temp_mailbox`

- [x] **Step 4: Verify command compile/tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml verification_code_row_maps_to_command_dto
cargo test --manifest-path src-tauri/Cargo.toml verification_poll_result_maps_to_command_dto
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: tests and check pass.

- [x] **Step 5: Commit commands**

Run:

```powershell
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: expose verification code commands"
```

---

## Task 5: Waiting-mode and copy-code UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Implement UI state and command calls**

Update TypeScript DTOs:

```ts
type VerificationCodeDto = {
  id: string;
  message_id: string;
  temp_mailbox_id: string | null;
  source_id: string;
  account_scope: string;
  received_address: string;
  code: string;
  issuer_hint: string | null;
  target_service_hint: string | null;
  confidence: number;
  expires_at: string | null;
  extracted_at: string;
  subject: string;
  from_address: string;
  observed_at: string;
};

type VerificationPollDto = {
  refresh: TempRefreshDto;
  detected_code: VerificationCodeDto | null;
};
```

Add state:

```ts
const [waitForCode, setWaitForCode] = useState(true);
const [waitingMailboxId, setWaitingMailboxId] = useState<string | null>(null);
const [recentCodes, setRecentCodes] = useState<VerificationCodeDto[]>([]);
const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
```

Add helpers:

- `loadRecentCodes(tempMailboxId?: string | null)`.
- `pollWaitingMailbox(tempMailboxId: string)` invoking `verification_poll_temp_mailbox`.
- `copyCode(code: VerificationCodeDto)` using `navigator.clipboard.writeText(code.code)`.

- [x] **Step 2: Add waiting UI and polling effect**

UI behavior:

- Temporary mailbox form includes a checked-by-default "Wait for verification code" checkbox.
- After creating a mailbox, when `waitForCode` is true, set `waitingMailboxId` to the created mailbox id and start polling.
- Poll every 5 seconds while waiting.
- Stop polling when a code for that mailbox appears or the mailbox is no longer active/expiring.
- Recent-code panel shows code, issuer, received address, source message id, observed time, extracted time, confidence, copy button, and an "Original message: <message_id>" traceability link label until the full message-detail route exists.

- [x] **Step 3: Style recent codes and waiting state**

Add styles:

- `.code-list`
- `.code-row`
- `.code-value`
- `.copy-button`
- `.waiting-banner`

- [x] **Step 4: Verify UI compile**

Run:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both pass.

- [x] **Step 5: Commit UI**

Run:

```powershell
git add src/App.tsx src/App.css
git commit -m "feat: add verification code waiting UI"
```

---

## Task 6: Full verification and tracker closeout

**Files:**
- Modify: `docs/progress/MASTER.md`
- Modify: `docs/progress/phase-4-verification-codes.md`
- Modify: `docs/superpowers/plans/2026-06-12-easyemailam-verification-codes.md`

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

- `docs/progress/phase-4-verification-codes.md`: mark all Phase 4 tasks complete with evidence.
- `docs/progress/MASTER.md`: Phase 4 becomes 7/7, overall progress becomes 36/68, active phase becomes Phase 5.

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
git add docs/progress docs/superpowers/plans/2026-06-12-easyemailam-verification-codes.md
git commit -m "docs: mark verification code phase executed"
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

- Extractor tests failed before `VerificationExtractionInput` and `extract_verification_code` existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml extracts_common_6_digit_verification_code`
  - `cargo test --manifest-path src-tauri/Cargo.toml extracts_code_from_subject_or_body`
- Redaction test failed until verification-code-like values were redacted:
  - `cargo test --manifest-path src-tauri/Cargo.toml verification_code_not_logged_plain_by_default`
- Repository tests failed before `RecentVerificationCodeFilter`, `load_message_for_verification`, `persist_verification_code`, and `list_recent_verification_codes` existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml associates_code_with_temp_mailbox_received_address`
  - `cargo test --manifest-path src-tauri/Cargo.toml recent_codes_can_filter_by_temp_mailbox`
- Service tests failed before `VerificationReclassifyRequest`, `VerificationPollTempMailboxRequest`, `reclassify_message`, and `poll_temp_mailbox_for_code` existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml refresh_temp_mailbox_extracts_codes_for_inserted_messages`
  - `cargo test --manifest-path src-tauri/Cargo.toml reclassify_message_updates_existing_code`
  - `cargo test --manifest-path src-tauri/Cargo.toml wait_for_code_polling_reports_detected_code`
- Command DTO tests failed before command mapping helpers existed:
  - `cargo test --manifest-path src-tauri/Cargo.toml verification_code_row_maps_to_command_dto`
  - `cargo test --manifest-path src-tauri/Cargo.toml verification_poll_result_maps_to_command_dto`

### Targeted green evidence

The targeted tests above passed after implementation:

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

### Debugging evidence

The first full `npm run verify` run reached 45 passed / 1 failed Rust tests. The failure was `easyemail::http::tests::http_open_mailbox_maps_canonical_fields` with Windows `os error 10053`, caused by the test TCP server reading a POST request only once and potentially closing before the client finished sending the request body. The test server was fixed to read through headers and `Content-Length` before responding. The targeted test then passed.

### Full verification evidence

- `npm run verify` passed:
  - `npm run build` passed.
  - `cargo fmt` passed.
  - `cargo test` passed with 46 tests.
  - `cargo check` passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

### Commits

- `9c733a7 docs: plan verification code phase`
- `da0d61a feat: extract verification codes`
- `0688c93 feat: persist verification code records`
- `120392a feat: classify temp mailbox verification codes`
- `dacfe55 feat: expose verification code commands`
- `66ad6d7 feat: add verification code waiting UI`
- `bb761a3 test: stabilize easyemail http mock server`

### Remaining phases

- Phase 0 still has EventBus and logging skeleton gaps.
- Phase 5 remains: promote temporary mailbox.
- Phase 6 remains: normal IMAP basics.
- Phase 7 remains: SMTP and send queue.
- Phase 8 remains: Agent mailbox MVP.
