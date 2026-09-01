# EasyEmailAM Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the first working EasyEmailAM foundation slice: a Tauri 2 desktop shell, Rust core structure, SQLite migration runner, canonical account/temp-mailbox/message tables, repository invariants, a health command, and minimal React UI.

**Architecture:** This plan starts from the current nearly empty workspace and creates a Tauri + React + Rust app without deleting the approved design spec. Rust owns domain rules, SQLite persistence, command DTOs, error redaction, and repository invariants. React only calls a health command and renders the foundation status.

**Tech Stack:** Tauri 2, React 19, TypeScript, Rust 1.95, rusqlite 0.40.1 with bundled SQLite, serde, serde_json, uuid, chrono, thiserror, npm.

---

## Scope and source facts

This plan implements the first executable plan only: Milestone 0 and the repository-focused part of Milestone 1 from `docs/superpowers/specs/2026-06-11-easyemailam-design.md`.

Current workspace facts verified before writing this plan:

- `C:\Users\Public\nas_home\AI\GameEditor\EasyEmailAM` contains `docs/` and `.superpowers/`.
- `docs/superpowers/specs/2026-06-11-easyemailam-design.md` exists.
- `docs/superpowers/plans/2026-06-11-easyemailam-foundation.md` was missing before this plan was written.
- The directory is not currently a git repository.
- `create-tauri-app . --force` must not be used in the project root because a probe showed it can remove existing `docs/`.
- Safe scaffold path: create the Tauri app under `.bootstrap/easyemailam-template`, copy generated files into the root, then remove `.bootstrap`.

Out of scope for this plan:

- Real EasyEmail HTTP adapter.
- Real IMAP/SMTP adapters.
- OAuth flows.
- Send queue worker.
- Agent mailbox MVP.
- Full mailbox UI.

Those become separate plans after this foundation compiles and passes tests.

## File structure

Create or modify these files.

```text
package.json
index.html
tsconfig.json
vite.config.ts
src/main.tsx
src/App.tsx
src/App.css
src/vite-env.d.ts
src-tauri/Cargo.toml
src-tauri/build.rs
src-tauri/tauri.conf.json
src-tauri/src/main.rs
src-tauri/src/lib.rs
src-tauri/src/app_state.rs
src-tauri/src/commands.rs
src-tauri/src/error.rs
src-tauri/src/redaction.rs
src-tauri/src/time.rs
src-tauri/src/domain/mod.rs
src-tauri/src/domain/account.rs
src-tauri/src/domain/message.rs
src-tauri/src/domain/sync_state.rs
src-tauri/src/domain/temp_mailbox.rs
src-tauri/src/domain/verification.rs
src-tauri/src/storage/mod.rs
src-tauri/src/storage/db.rs
src-tauri/src/storage/migrations.rs
src-tauri/src/storage/account_repository.rs
src-tauri/src/storage/temp_mailbox_repository.rs
src-tauri/src/storage/message_repository.rs
src-tauri/migrations/0001_foundation.sql
```

Responsibility boundaries:

- `domain/*`: pure Rust types and invariants. No SQL, no Tauri.
- `storage/*`: SQLite schema execution and repository queries. No Tauri command DTOs.
- `commands.rs`: Tauri command boundary. DTOs are serialized here.
- `app_state.rs`: shared runtime state and database handle.
- `error.rs` and `redaction.rs`: uniform errors and secret-safe serialization support.
- `src/*`: minimal UI only; it must not duplicate backend rules.

---

## Task 1: Initialize git and scaffold Tauri safely

**Files:**
- Create: `.git/`
- Create: Tauri template files under project root
- Preserve: `docs/superpowers/specs/2026-06-11-easyemailam-design.md`

- [x] **Step 1: Verify the root state before scaffolding**

Run:

```powershell
Get-Location
Get-ChildItem -Force | Select-Object Mode,Length,LastWriteTime,Name | Format-Table -AutoSize
git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host 'NO_GIT_REPOSITORY' }
Test-Path -LiteralPath 'docs\superpowers\specs\2026-06-11-easyemailam-design.md'
```

Expected:

```text
Current path is C:\Users\Public\nas_home\AI\GameEditor\EasyEmailAM
NO_GIT_REPOSITORY
True
```

- [x] **Step 2: Initialize git with local identity on the foundation branch**

Run:

```powershell
git init -b foundation
git config user.name "EasyEmailAM Agent"
git config user.email "easyemailam-agent@example.local"
git status --short --branch
```

Expected:

```text
## No commits yet on foundation
?? .superpowers/
?? docs/
```

- [x] **Step 3: Create the Tauri template in a temporary project subdirectory**

Run:

```powershell
if (Test-Path -LiteralPath '.bootstrap') {
  Remove-Item -LiteralPath '.bootstrap' -Recurse -Force
}
npm create tauri-app@latest .bootstrap/easyemailam-template -- --template react-ts --manager npm --identifier com.easyemailam.app --tauri-version 2 -y
```

Expected:

```text
Template created!
```

- [x] **Step 4: Copy generated files into the project root without touching docs**

Run:

```powershell
$template = Resolve-Path -LiteralPath '.bootstrap\easyemailam-template'
$root = Get-Location
Get-ChildItem -LiteralPath $template -Force |
  Where-Object { $_.Name -notin @('.git') } |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $root $_.Name) -Recurse -Force
  }
Remove-Item -LiteralPath '.bootstrap' -Recurse -Force
Test-Path -LiteralPath 'docs\superpowers\specs\2026-06-11-easyemailam-design.md'
Test-Path -LiteralPath 'src-tauri\Cargo.toml'
Test-Path -LiteralPath 'src\App.tsx'
```

Expected:

```text
True
True
True
```

- [x] **Step 5: Install frontend dependencies**

Run:

```powershell
npm install
```

Expected:

```text
added
```

The exact package count is allowed to differ.

- [x] **Step 6: Commit the safe scaffold**

Run:

```powershell
git add package.json package-lock.json index.html tsconfig.json vite.config.ts src src-tauri docs .gitignore
git commit -m "chore: scaffold tauri foundation"
```

Expected:

```text
[master (root-commit)
```

or:

```text
[main (root-commit)
```

---

## Task 2: Normalize project metadata and dependency baseline

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/main.rs`

- [x] **Step 1: Replace `package.json` with stable scripts**

Write `package.json` exactly as:

```json
{
  "name": "easyemailam",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "rust:fmt": "cargo fmt --manifest-path src-tauri/Cargo.toml",
    "rust:test": "cargo test --manifest-path src-tauri/Cargo.toml",
    "rust:check": "cargo check --manifest-path src-tauri/Cargo.toml",
    "verify": "npm run build && npm run rust:fmt && npm run rust:test && npm run rust:check"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-opener": "^2",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^4.6.0",
    "typescript": "~5.8.3",
    "vite": "^7.0.4"
  }
}
```

- [x] **Step 2: Replace `src-tauri/Cargo.toml` with the foundation dependencies**

Write `src-tauri/Cargo.toml` exactly as:

```toml
[package]
name = "easyemailam"
version = "0.1.0"
description = "EasyEmailAM desktop mailbox aggregation app"
authors = ["EasyEmailAM contributors"]
edition = "2021"

[lib]
name = "easyemailam_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
chrono = { version = "0.4.42", default-features = false, features = ["clock", "std", "serde"] }
rusqlite = { version = "0.40.1", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
thiserror = "2.0.18"
uuid = { version = "1.23.3", features = ["v4", "serde"] }
```

- [x] **Step 3: Replace `src-tauri/tauri.conf.json` with EasyEmailAM metadata**

Write `src-tauri/tauri.conf.json` exactly as:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "EasyEmailAM",
  "version": "0.1.0",
  "identifier": "com.easyemailam.app",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "EasyEmailAM",
        "width": 1180,
        "height": 760
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

- [x] **Step 4: Ensure `src-tauri/src/main.rs` points to the renamed library**

Write `src-tauri/src/main.rs` exactly as:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    easyemailam_lib::run()
}
```

- [x] **Step 5: Verify metadata compiles far enough to resolve dependencies**

Run:

```powershell
npm install
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected:

```text
Finished `dev` profile
```

The default template code still compiles at this point.

- [x] **Step 6: Commit metadata baseline**

Run:

```powershell
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/src/main.rs
git commit -m "chore: normalize project metadata"
```

Expected:

```text
[master
```

or:

```text
[main
```

---

## Task 3: Add error and redaction foundation

**Files:**
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/redaction.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing redaction and error tests**

Create `src-tauri/src/redaction.rs` with this initial test-first content:

```rust
use serde_json::Value;

pub fn redact_text(value: &str) -> String {
    value.to_string()
}

pub fn redact_json(value: &Value) -> Value {
    value.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_token_like_text() {
        let input = "access_token=abc123 refresh_token=def456 password=secret";
        let redacted = redact_text(input);

        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("def456"));
        assert!(!redacted.contains("secret"));
        assert!(redacted.contains("access_token=[REDACTED]"));
        assert!(redacted.contains("refresh_token=[REDACTED]"));
        assert!(redacted.contains("password=[REDACTED]"));
    }

    #[test]
    fn redacts_secret_like_json_keys() {
        let value = json!({
            "account_id": "acc_1",
            "token": "abc",
            "nested": {
                "password": "secret",
                "safe": "visible"
            }
        });

        let redacted = redact_json(&value);

        assert_eq!(redacted["account_id"], "acc_1");
        assert_eq!(redacted["token"], "[REDACTED]");
        assert_eq!(redacted["nested"]["password"], "[REDACTED]");
        assert_eq!(redacted["nested"]["safe"], "visible");
    }
}
```

Create `src-tauri/src/error.rs` with this initial test-first content:

```rust
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Auth,
    Network,
    Provider,
    Protocol,
    Storage,
    Validation,
    RateLimit,
    Unsupported,
    Internal,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionRequired {
    Reauthorize,
    EditSettings,
    Wait,
    Retry,
    Confirm,
    UnlockVault,
    CheckEasyEmailConnection,
    None,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ErrorDto {
    pub code: String,
    pub category: ErrorCategory,
    pub user_message: String,
    pub technical_message: Option<String>,
    pub retryable: bool,
    pub action_required: ActionRequired,
    pub correlation_id: String,
    pub metadata: Value,
}

#[derive(Debug, Error)]
#[error("{code}: {user_message}")]
pub struct AppError {
    pub code: String,
    pub category: ErrorCategory,
    pub user_message: String,
    pub technical_message: Option<String>,
    pub retryable: bool,
    pub action_required: ActionRequired,
    pub correlation_id: String,
    pub metadata: Value,
}

impl AppError {
    pub fn internal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            category: ErrorCategory::Internal,
            user_message: message.into(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: Uuid::new_v4().to_string(),
            metadata: Value::Object(Default::default()),
        }
    }

    pub fn to_dto(&self) -> ErrorDto {
        ErrorDto {
            code: self.code.clone(),
            category: self.category.clone(),
            user_message: self.user_message.clone(),
            technical_message: self.technical_message.clone(),
            retryable: self.retryable,
            action_required: self.action_required.clone(),
            correlation_id: self.correlation_id.clone(),
            metadata: self.metadata.clone(),
        }
    }
}

impl From<AppError> for ErrorDto {
    fn from(value: AppError) -> Self {
        value.to_dto()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_error_serialization_has_code_category_user_message() {
        let error = AppError {
            code: "keychain_unavailable".to_string(),
            category: ErrorCategory::Storage,
            user_message: "Secure storage is unavailable.".to_string(),
            technical_message: Some("windows credential manager returned 5".to_string()),
            retryable: false,
            action_required: ActionRequired::UnlockVault,
            correlation_id: "corr_1".to_string(),
            metadata: json!({"password": "secret"}),
        };

        let dto = error.to_dto();

        assert_eq!(dto.code, "keychain_unavailable");
        assert_eq!(dto.category, ErrorCategory::Storage);
        assert_eq!(dto.user_message, "Secure storage is unavailable.");
        assert_eq!(dto.action_required, ActionRequired::UnlockVault);
        assert_eq!(dto.metadata["password"], "[REDACTED]");
    }
}
```

Modify `src-tauri/src/lib.rs` to expose the modules while retaining the template command:

```rust
pub mod error;
pub mod redaction;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml redacts_ app_error_serialization_has_code_category_user_message -- --nocapture
```

Expected:

```text
FAILED
redacts_token_like_text
redacts_secret_like_json_keys
app_error_serialization_has_code_category_user_message
```

- [x] **Step 3: Implement redaction and safe error DTO metadata**

Replace `src-tauri/src/redaction.rs` with:

```rust
use serde_json::{Map, Value};

const REDACTED: &str = "[REDACTED]";

fn is_secret_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    lowered.contains("password")
        || lowered.contains("token")
        || lowered.contains("secret")
        || lowered.contains("authorization")
        || lowered.contains("api_key")
        || lowered.contains("apikey")
}

pub fn redact_text(value: &str) -> String {
    value
        .split_whitespace()
        .map(|part| {
            let lowered = part.to_ascii_lowercase();
            let secret_prefixes = [
                "access_token=",
                "refresh_token=",
                "password=",
                "token=",
                "secret=",
                "api_key=",
                "apikey=",
            ];

            for prefix in secret_prefixes {
                if lowered.starts_with(prefix) {
                    return format!("{prefix}{REDACTED}");
                }
            }

            part.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn redact_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = Map::new();
            for (key, nested) in object {
                if is_secret_key(key) {
                    redacted.insert(key.clone(), Value::String(REDACTED.to_string()));
                } else {
                    redacted.insert(key.clone(), redact_json(nested));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(values) => Value::Array(values.iter().map(redact_json).collect()),
        Value::String(text) => Value::String(redact_text(text)),
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_token_like_text() {
        let input = "access_token=abc123 refresh_token=def456 password=secret";
        let redacted = redact_text(input);

        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("def456"));
        assert!(!redacted.contains("secret"));
        assert!(redacted.contains("access_token=[REDACTED]"));
        assert!(redacted.contains("refresh_token=[REDACTED]"));
        assert!(redacted.contains("password=[REDACTED]"));
    }

    #[test]
    fn redacts_secret_like_json_keys() {
        let value = json!({
            "account_id": "acc_1",
            "token": "abc",
            "nested": {
                "password": "secret",
                "safe": "visible"
            }
        });

        let redacted = redact_json(&value);

        assert_eq!(redacted["account_id"], "acc_1");
        assert_eq!(redacted["token"], "[REDACTED]");
        assert_eq!(redacted["nested"]["password"], "[REDACTED]");
        assert_eq!(redacted["nested"]["safe"], "visible");
    }
}
```

Replace only the `to_dto` implementation in `src-tauri/src/error.rs` with:

```rust
    pub fn to_dto(&self) -> ErrorDto {
        ErrorDto {
            code: self.code.clone(),
            category: self.category.clone(),
            user_message: self.user_message.clone(),
            technical_message: self.technical_message.clone(),
            retryable: self.retryable,
            action_required: self.action_required.clone(),
            correlation_id: self.correlation_id.clone(),
            metadata: crate::redaction::redact_json(&self.metadata),
        }
    }
```

- [x] **Step 4: Run tests to verify they pass**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml redacts_ app_error_serialization_has_code_category_user_message
```

Expected:

```text
test result: ok
```

- [x] **Step 5: Commit error and redaction foundation**

Run:

```powershell
git add src-tauri/src/lib.rs src-tauri/src/error.rs src-tauri/src/redaction.rs
git commit -m "feat: add error and redaction foundation"
```

Expected:

```text
[master
```

or:

```text
[main
```

---

## Task 4: Add domain models for account, temp mailbox, message, sync, and verification

**Files:**
- Create: `src-tauri/src/domain/mod.rs`
- Create: `src-tauri/src/domain/account.rs`
- Create: `src-tauri/src/domain/temp_mailbox.rs`
- Create: `src-tauri/src/domain/message.rs`
- Create: `src-tauri/src/domain/sync_state.rs`
- Create: `src-tauri/src/domain/verification.rs`
- Create: `src-tauri/src/time.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write pure domain files with invariant tests**

Create `src-tauri/src/time.rs`:

```rust
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}
```

Create `src-tauri/src/domain/mod.rs`:

```rust
pub mod account;
pub mod message;
pub mod sync_state;
pub mod temp_mailbox;
pub mod verification;
```

Create `src-tauri/src/domain/account.rs`:

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountScope {
    Normal,
    Agent,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    NormalLongLived,
    NormalUpgradedTemp,
    AnonymousVirtual,
    AgentOwned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    Ready,
    Configuring,
    Syncing,
    Degraded,
    Disabled,
    HistoryOnly,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    NotRequired,
    Valid,
    Expired,
    Invalid,
    Missing,
    Refreshing,
    ReauthorizationRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiveStatus {
    Enabled,
    Syncing,
    Backoff,
    AuthFailed,
    ProviderUnavailable,
    Expired,
    Disabled,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SendStatus {
    Enabled,
    Sending,
    QueuedOnly,
    AuthFailed,
    SmtpUnavailable,
    RateLimited,
    Disabled,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub scope: AccountScope,
    pub kind: AccountKind,
    pub display_name: String,
    pub primary_address: Option<String>,
    pub provider_label: Option<String>,
    pub status: AccountStatus,
    pub auth_status: AuthStatus,
    pub receive_status: ReceiveStatus,
    pub send_status: SendStatus,
    pub listed_in_all_accounts: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Account {
    pub fn anonymous_virtual(now: String) -> Self {
        Self {
            id: "acct_anonymous_virtual".to_string(),
            scope: AccountScope::System,
            kind: AccountKind::AnonymousVirtual,
            display_name: "Anonymous Mailbox".to_string(),
            primary_address: None,
            provider_label: None,
            status: AccountStatus::Ready,
            auth_status: AuthStatus::NotRequired,
            receive_status: ReceiveStatus::Enabled,
            send_status: SendStatus::Unsupported,
            listed_in_all_accounts: true,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn agent_owned(display_name: String, address: String, now: String) -> Self {
        Self {
            id: format!("acct_{}", Uuid::new_v4()),
            scope: AccountScope::Agent,
            kind: AccountKind::AgentOwned,
            display_name,
            primary_address: Some(address),
            provider_label: None,
            status: AccountStatus::Configuring,
            auth_status: AuthStatus::Missing,
            receive_status: ReceiveStatus::Disabled,
            send_status: SendStatus::Disabled,
            listed_in_all_accounts: false,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn normal_upgraded_temp(address: String, provider_label: Option<String>, now: String) -> Self {
        Self {
            id: format!("acct_{}", Uuid::new_v4()),
            scope: AccountScope::Normal,
            kind: AccountKind::NormalUpgradedTemp,
            display_name: address.clone(),
            primary_address: Some(address),
            provider_label,
            status: AccountStatus::Ready,
            auth_status: AuthStatus::NotRequired,
            receive_status: ReceiveStatus::Enabled,
            send_status: SendStatus::Unsupported,
            listed_in_all_accounts: true,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_virtual_must_be_system_scope() {
        let account = Account::anonymous_virtual("2026-06-11T00:00:00Z".to_string());

        assert_eq!(account.scope, AccountScope::System);
        assert_eq!(account.kind, AccountKind::AnonymousVirtual);
        assert!(account.listed_in_all_accounts);
        assert_eq!(account.send_status, SendStatus::Unsupported);
    }

    #[test]
    fn agent_owned_is_not_visible_in_normal_all_accounts() {
        let account = Account::agent_owned(
            "Agent Sender".to_string(),
            "agent@example.com".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );

        assert_eq!(account.scope, AccountScope::Agent);
        assert_eq!(account.kind, AccountKind::AgentOwned);
        assert!(!account.listed_in_all_accounts);
    }
}
```

Create `src-tauri/src/domain/temp_mailbox.rs`:

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TempVisibilityState {
    Anonymous,
    Upgraded,
    Archived,
    Hidden,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TempLifecycleState {
    Active,
    Expiring,
    Expired,
    ReceiveUnavailable,
    ProviderUnavailable,
    HistoryOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TempMailbox {
    pub id: String,
    pub email_address: String,
    pub provider_id: String,
    pub provider_label: String,
    pub visibility_state: TempVisibilityState,
    pub lifecycle_state: TempLifecycleState,
    pub upgraded_account_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl TempMailbox {
    pub fn new_anonymous(
        email_address: String,
        provider_id: String,
        provider_label: String,
        now: String,
    ) -> Self {
        Self {
            id: format!("temp_{}", Uuid::new_v4()),
            email_address,
            provider_id,
            provider_label,
            visibility_state: TempVisibilityState::Anonymous,
            lifecycle_state: TempLifecycleState::Active,
            upgraded_account_id: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_mailbox_default_visibility_is_anonymous() {
        let mailbox = TempMailbox::new_anonymous(
            "code@example.test".to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );

        assert_eq!(mailbox.visibility_state, TempVisibilityState::Anonymous);
        assert_eq!(mailbox.lifecycle_state, TempLifecycleState::Active);
        assert_eq!(mailbox.upgraded_account_id, None);
    }
}
```

Create `src-tauri/src/domain/message.rs`:

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub rfc_message_id: Option<String>,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageSource {
    pub id: String,
    pub message_id: String,
    pub source_id: String,
    pub account_id: Option<String>,
    pub temp_mailbox_id: Option<String>,
    pub provider_message_id: Option<String>,
    pub received_address: Option<String>,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

impl Message {
    pub fn new(subject: String, from_address: String, snippet: String, now: String) -> Self {
        Self {
            id: format!("msg_{}", Uuid::new_v4()),
            rfc_message_id: None,
            subject,
            from_address,
            snippet,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}
```

Create `src-tauri/src/domain/sync_state.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    Idle,
    Syncing,
    Success,
    Backoff,
    Failed,
    Paused,
    Disabled,
}
```

Create `src-tauri/src/domain/verification.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerificationCode {
    pub id: String,
    pub message_id: String,
    pub received_address: String,
    pub code: String,
    pub extracted_at: String,
}
```

Modify the top of `src-tauri/src/lib.rs` so it includes:

```rust
pub mod domain;
pub mod error;
pub mod redaction;
pub mod time;
```

- [x] **Step 2: Run domain tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml anonymous_virtual_must_be_system_scope agent_owned_is_not_visible_in_normal_all_accounts temp_mailbox_default_visibility_is_anonymous
```

Expected:

```text
test result: ok
```

- [x] **Step 3: Commit domain model foundation**

Run:

```powershell
git add src-tauri/src/lib.rs src-tauri/src/time.rs src-tauri/src/domain
git commit -m "feat: add foundation domain models"
```

Expected:

```text
[master
```

or:

```text
[main
```

---

## Task 5: Add SQLite migration runner and foundation schema

**Files:**
- Create: `src-tauri/src/storage/mod.rs`
- Create: `src-tauri/src/storage/db.rs`
- Create: `src-tauri/src/storage/migrations.rs`
- Create: `src-tauri/migrations/0001_foundation.sql`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write migration and runner tests first**

Create `src-tauri/src/storage/mod.rs`:

```rust
pub mod db;
pub mod migrations;
```

Create `src-tauri/src/storage/db.rs`:

```rust
use std::path::Path;

use rusqlite::{Connection, Result};

pub fn open_database(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(connection)
}

pub fn open_in_memory_database() -> Result<Connection> {
    let connection = Connection::open_in_memory()?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(connection)
}
```

Create `src-tauri/src/storage/migrations.rs`:

```rust
use rusqlite::{params, Connection, Result};

const MIGRATION_0001: &str = include_str!("../../migrations/0001_foundation.sql");

pub fn run_migrations(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )?;

    let already_applied: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
        params![1_i64],
        |row| row.get(0),
    )?;

    if !already_applied {
        connection.execute_batch(MIGRATION_0001)?;
        connection.execute(
            "INSERT INTO schema_migrations(version, name) VALUES (?1, ?2)",
            params![1_i64, "foundation"],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::open_in_memory_database;

    #[test]
    fn migrations_apply_cleanly() {
        let connection = open_in_memory_database().expect("open in-memory database");

        run_migrations(&connection).expect("run migrations");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (
                    'accounts',
                    'mailbox_sources',
                    'credential_refs',
                    'temp_mailboxes',
                    'messages',
                    'message_sources',
                    'sync_states',
                    'verification_codes',
                    'app_settings'
                )",
                [],
                |row| row.get(0),
            )
            .expect("count foundation tables");

        assert_eq!(count, 9);
    }

    #[test]
    fn migrations_are_idempotent() {
        let connection = open_in_memory_database().expect("open in-memory database");

        run_migrations(&connection).expect("first migration run");
        run_migrations(&connection).expect("second migration run");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations WHERE version = 1", [], |row| {
                row.get(0)
            })
            .expect("count migration records");

        assert_eq!(count, 1);
    }
}
```

Create `src-tauri/migrations/0001_foundation.sql` with a deliberately incomplete schema first:

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  primary_address TEXT,
  provider_label TEXT,
  status TEXT NOT NULL,
  auth_status TEXT NOT NULL,
  receive_status TEXT NOT NULL,
  send_status TEXT NOT NULL,
  listed_in_all_accounts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

Modify the top of `src-tauri/src/lib.rs` so it includes:

```rust
pub mod domain;
pub mod error;
pub mod redaction;
pub mod storage;
pub mod time;
```

- [x] **Step 2: Run migration tests to verify failure**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml migrations_apply_cleanly migrations_are_idempotent -- --nocapture
```

Expected:

```text
migrations_apply_cleanly ... FAILED
```

The failure proves the test catches a missing schema.

- [x] **Step 3: Replace migration SQL with the full foundation schema**

Replace `src-tauri/migrations/0001_foundation.sql` with:

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('normal', 'agent', 'system')),
  kind TEXT NOT NULL CHECK (kind IN ('normal_long_lived', 'normal_upgraded_temp', 'anonymous_virtual', 'agent_owned')),
  display_name TEXT NOT NULL,
  primary_address TEXT,
  provider_label TEXT,
  status TEXT NOT NULL,
  auth_status TEXT NOT NULL,
  receive_status TEXT NOT NULL,
  send_status TEXT NOT NULL,
  listed_in_all_accounts INTEGER NOT NULL CHECK (listed_in_all_accounts IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_anonymous_virtual
ON accounts(kind)
WHERE kind = 'anonymous_virtual' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_normal_visible
ON accounts(scope, listed_in_all_accounts, deleted_at);

CREATE TABLE IF NOT EXISTS mailbox_sources (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  source_kind TEXT NOT NULL,
  address TEXT,
  provider_id TEXT,
  credential_ref_id TEXT,
  status TEXT NOT NULL,
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS credential_refs (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT,
  source_id TEXT,
  secret_backend TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  credential_kind TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  FOREIGN KEY(owner_account_id) REFERENCES accounts(id),
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id)
);

CREATE TABLE IF NOT EXISTS temp_mailboxes (
  id TEXT PRIMARY KEY,
  email_address TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  domain TEXT,
  local_part TEXT,
  easyemail_mailbox_id TEXT,
  source_id TEXT,
  visibility_state TEXT NOT NULL CHECK (visibility_state IN ('anonymous', 'upgraded', 'archived', 'hidden')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'expiring', 'expired', 'receive_unavailable', 'provider_unavailable', 'history_only')),
  lease_expires_at TEXT,
  renewable_until TEXT,
  last_fetch_at TEXT,
  last_success_at TEXT,
  upgraded_account_id TEXT,
  raw_provider_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id),
  FOREIGN KEY(upgraded_account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_temp_mailboxes_visibility
ON temp_mailboxes(visibility_state, lifecycle_state);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  rfc_message_id TEXT,
  thread_key TEXT,
  subject TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  date_sent TEXT,
  date_received TEXT,
  snippet TEXT NOT NULL DEFAULT '',
  body_text_cache TEXT,
  body_html_cache TEXT,
  body_cache_state TEXT NOT NULL DEFAULT 'headers_only',
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  size_bytes INTEGER,
  classification TEXT NOT NULL DEFAULT 'normal',
  security_flags TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_rfc_message_id
ON messages(rfc_message_id);

CREATE TABLE IF NOT EXISTS message_sources (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  account_id TEXT,
  folder_id TEXT,
  temp_mailbox_id TEXT,
  provider_message_id TEXT,
  imap_uid TEXT,
  imap_uidvalidity TEXT,
  easyemail_message_id TEXT,
  received_address TEXT,
  flags_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id),
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(temp_mailbox_id) REFERENCES temp_mailboxes(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_sources_easyemail_unique
ON message_sources(temp_mailbox_id, easyemail_message_id)
WHERE temp_mailbox_id IS NOT NULL AND easyemail_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sync_states (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  folder_id TEXT,
  sync_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  last_started_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  FOREIGN KEY(source_id) REFERENCES mailbox_sources(id)
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  received_address TEXT NOT NULL,
  code TEXT NOT NULL,
  issuer_hint TEXT,
  target_service_hint TEXT,
  confidence REAL NOT NULL,
  expires_at TEXT,
  extracted_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_verification_codes_recent
ON verification_codes(extracted_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [x] **Step 4: Run migration tests to verify pass**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml migrations_apply_cleanly migrations_are_idempotent
```

Expected:

```text
test result: ok
```

- [x] **Step 5: Commit migration foundation**

Run:

```powershell
git add src-tauri/src/lib.rs src-tauri/src/storage src-tauri/migrations
git commit -m "feat: add sqlite foundation schema"
```

Expected:

```text
[master
```

or:

```text
[main
```

---

## Task 6: Add account and temp mailbox repositories with upgrade invariant

**Files:**
- Create: `src-tauri/src/storage/account_repository.rs`
- Create: `src-tauri/src/storage/temp_mailbox_repository.rs`
- Modify: `src-tauri/src/storage/mod.rs`

- [x] **Step 1: Write account repository code and tests**

Create `src-tauri/src/storage/account_repository.rs`:

```rust
use rusqlite::{params, Connection, OptionalExtension, Result};

use crate::domain::account::Account;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRow {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub display_name: String,
    pub primary_address: Option<String>,
    pub listed_in_all_accounts: bool,
}

fn map_account_row(row: &rusqlite::Row<'_>) -> Result<AccountRow> {
    Ok(AccountRow {
        id: row.get("id")?,
        scope: row.get("scope")?,
        kind: row.get("kind")?,
        display_name: row.get("display_name")?,
        primary_address: row.get("primary_address")?,
        listed_in_all_accounts: row.get::<_, i64>("listed_in_all_accounts")? == 1,
    })
}

pub fn insert_account(connection: &Connection, account: &Account) -> Result<()> {
    connection.execute(
        "INSERT INTO accounts (
            id,
            scope,
            kind,
            display_name,
            primary_address,
            provider_label,
            status,
            auth_status,
            receive_status,
            send_status,
            listed_in_all_accounts,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            account.id,
            enum_to_snake(&account.scope),
            enum_to_snake(&account.kind),
            account.display_name,
            account.primary_address,
            account.provider_label,
            enum_to_snake(&account.status),
            enum_to_snake(&account.auth_status),
            enum_to_snake(&account.receive_status),
            enum_to_snake(&account.send_status),
            if account.listed_in_all_accounts { 1_i64 } else { 0_i64 },
            account.created_at,
            account.updated_at,
        ],
    )?;

    Ok(())
}

pub fn ensure_anonymous_virtual_account(connection: &Connection, now: String) -> Result<String> {
    let existing: Option<String> = connection
        .query_row(
            "SELECT id FROM accounts WHERE kind = 'anonymous_virtual' AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(id) = existing {
        return Ok(id);
    }

    let account = Account::anonymous_virtual(now);
    let id = account.id.clone();
    insert_account(connection, &account)?;
    Ok(id)
}

pub fn list_normal_accounts(connection: &Connection) -> Result<Vec<AccountRow>> {
    let mut statement = connection.prepare(
        "SELECT id, scope, kind, display_name, primary_address, listed_in_all_accounts
         FROM accounts
         WHERE deleted_at IS NULL
           AND listed_in_all_accounts = 1
           AND (scope = 'normal' OR kind = 'anonymous_virtual')
         ORDER BY created_at ASC, id ASC",
    )?;

    let rows = statement.query_map([], map_account_row)?;
    rows.collect()
}

pub fn enum_to_snake<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .expect("serialize enum")
        .as_str()
        .expect("enum serializes to string")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::account::Account;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    #[test]
    fn ensure_anonymous_virtual_account_is_idempotent() {
        let connection = test_connection();

        let first = ensure_anonymous_virtual_account(&connection, "2026-06-11T00:00:00Z".to_string())
            .expect("first ensure");
        let second = ensure_anonymous_virtual_account(&connection, "2026-06-11T00:01:00Z".to_string())
            .expect("second ensure");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM accounts WHERE kind = 'anonymous_virtual'", [], |row| {
                row.get(0)
            })
            .expect("count anonymous accounts");

        assert_eq!(first, "acct_anonymous_virtual");
        assert_eq!(first, second);
        assert_eq!(count, 1);
    }

    #[test]
    fn normal_account_query_excludes_agent_accounts() {
        let connection = test_connection();
        ensure_anonymous_virtual_account(&connection, "2026-06-11T00:00:00Z".to_string())
            .expect("ensure anonymous");

        let agent = Account::agent_owned(
            "Agent Sender".to_string(),
            "agent@example.test".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );
        insert_account(&connection, &agent).expect("insert agent account");

        let rows = list_normal_accounts(&connection).expect("list normal accounts");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "acct_anonymous_virtual");
        assert_eq!(rows[0].kind, "anonymous_virtual");
    }
}
```

Modify `src-tauri/src/storage/mod.rs`:

```rust
pub mod account_repository;
pub mod db;
pub mod migrations;
```

- [x] **Step 2: Run account repository tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml ensure_anonymous_virtual_account_is_idempotent normal_account_query_excludes_agent_accounts
```

Expected:

```text
test result: ok
```

- [x] **Step 3: Write temp mailbox repository code and tests**

Create `src-tauri/src/storage/temp_mailbox_repository.rs`:

```rust
use rusqlite::{params, Connection, OptionalExtension, Result};

use crate::domain::account::Account;
use crate::domain::temp_mailbox::TempMailbox;
use crate::storage::account_repository::{enum_to_snake, insert_account};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TempMailboxRow {
    pub id: String,
    pub email_address: String,
    pub visibility_state: String,
    pub lifecycle_state: String,
    pub upgraded_account_id: Option<String>,
}

pub fn insert_temp_mailbox(connection: &Connection, mailbox: &TempMailbox) -> Result<()> {
    connection.execute(
        "INSERT INTO temp_mailboxes (
            id,
            email_address,
            provider_id,
            provider_label,
            visibility_state,
            lifecycle_state,
            upgraded_account_id,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            mailbox.id,
            mailbox.email_address,
            mailbox.provider_id,
            mailbox.provider_label,
            enum_to_snake(&mailbox.visibility_state),
            enum_to_snake(&mailbox.lifecycle_state),
            mailbox.upgraded_account_id,
            mailbox.created_at,
            mailbox.updated_at,
        ],
    )?;

    Ok(())
}

pub fn get_temp_mailbox(connection: &Connection, id: &str) -> Result<Option<TempMailboxRow>> {
    connection
        .query_row(
            "SELECT id, email_address, visibility_state, lifecycle_state, upgraded_account_id
             FROM temp_mailboxes
             WHERE id = ?1",
            params![id],
            |row| {
                Ok(TempMailboxRow {
                    id: row.get("id")?,
                    email_address: row.get("email_address")?,
                    visibility_state: row.get("visibility_state")?,
                    lifecycle_state: row.get("lifecycle_state")?,
                    upgraded_account_id: row.get("upgraded_account_id")?,
                })
            },
        )
        .optional()
}

pub fn upgrade_temp_mailbox(connection: &mut Connection, temp_mailbox_id: &str, now: String) -> Result<String> {
    let transaction = connection.transaction()?;

    let (email_address, provider_label, lifecycle_state): (String, String, String) = transaction.query_row(
        "SELECT email_address, provider_label, lifecycle_state
         FROM temp_mailboxes
         WHERE id = ?1 AND visibility_state = 'anonymous'",
        params![temp_mailbox_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    let mut account = Account::normal_upgraded_temp(email_address, Some(provider_label), now.clone());
    if lifecycle_state == "expired" || lifecycle_state == "history_only" {
        account.status = crate::domain::account::AccountStatus::HistoryOnly;
        account.receive_status = crate::domain::account::ReceiveStatus::Expired;
    }

    let account_id = account.id.clone();
    insert_account(&transaction, &account)?;

    transaction.execute(
        "UPDATE temp_mailboxes
         SET visibility_state = 'upgraded',
             upgraded_account_id = ?1,
             updated_at = ?2
         WHERE id = ?3",
        params![account_id, now, temp_mailbox_id],
    )?;

    transaction.commit()?;
    Ok(account_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::temp_mailbox::TempMailbox;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    #[test]
    fn temp_mailbox_default_visibility_is_persisted_as_anonymous() {
        let connection = test_connection();
        let mailbox = TempMailbox::new_anonymous(
            "code@example.test".to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );

        insert_temp_mailbox(&connection, &mailbox).expect("insert temp mailbox");
        let row = get_temp_mailbox(&connection, &mailbox.id)
            .expect("get mailbox")
            .expect("mailbox exists");

        assert_eq!(row.visibility_state, "anonymous");
        assert_eq!(row.lifecycle_state, "active");
        assert_eq!(row.upgraded_account_id, None);
    }

    #[test]
    fn upgrade_temp_mailbox_transaction_creates_account_and_updates_visibility() {
        let mut connection = test_connection();
        let mailbox = TempMailbox::new_anonymous(
            "code@example.test".to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &mailbox).expect("insert temp mailbox");

        let account_id = upgrade_temp_mailbox(
            &mut connection,
            &mailbox.id,
            "2026-06-11T00:01:00Z".to_string(),
        )
        .expect("upgrade temp mailbox");

        let upgraded = get_temp_mailbox(&connection, &mailbox.id)
            .expect("get upgraded")
            .expect("upgraded exists");
        let account_kind: String = connection
            .query_row("SELECT kind FROM accounts WHERE id = ?1", params![account_id], |row| row.get(0))
            .expect("get account kind");

        assert_eq!(upgraded.visibility_state, "upgraded");
        assert!(upgraded.upgraded_account_id.is_some());
        assert_eq!(account_kind, "normal_upgraded_temp");
    }
}
```

Modify `src-tauri/src/storage/mod.rs`:

```rust
pub mod account_repository;
pub mod db;
pub mod migrations;
pub mod temp_mailbox_repository;
```

- [x] **Step 4: Run temp mailbox repository tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml temp_mailbox_default_visibility_is_persisted_as_anonymous upgrade_temp_mailbox_transaction_creates_account_and_updates_visibility
```

Expected:

```text
test result: ok
```

- [x] **Step 5: Commit repository invariants**

Run:

```powershell
git add src-tauri/src/storage
git commit -m "feat: add foundation repositories"
```

Expected:

```text
[master
```

or:

```text
[main
```

---

## Task 7: Add message repository and source trace invariant

**Files:**
- Create: `src-tauri/src/storage/message_repository.rs`
- Modify: `src-tauri/src/storage/mod.rs`

- [x] **Step 1: Write message repository with source trace test**

Create `src-tauri/src/storage/message_repository.rs`:

```rust
use rusqlite::{params, Connection, Result};
use uuid::Uuid;

use crate::domain::message::{Message, MessageSource};

pub fn insert_message(connection: &Connection, message: &Message) -> Result<()> {
    connection.execute(
        "INSERT INTO messages (
            id,
            rfc_message_id,
            subject,
            from_address,
            snippet,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            message.id,
            message.rfc_message_id,
            message.subject,
            message.from_address,
            message.snippet,
            message.created_at,
            message.updated_at,
        ],
    )?;

    Ok(())
}

pub fn insert_message_source(connection: &Connection, source: &MessageSource) -> Result<()> {
    connection.execute(
        "INSERT INTO message_sources (
            id,
            message_id,
            source_id,
            account_id,
            temp_mailbox_id,
            provider_message_id,
            received_address,
            first_seen_at,
            last_seen_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            source.id,
            source.message_id,
            source.source_id,
            source.account_id,
            source.temp_mailbox_id,
            source.provider_message_id,
            source.received_address,
            source.first_seen_at,
            source.last_seen_at,
        ],
    )?;

    Ok(())
}

pub fn create_temp_message_source(
    message_id: String,
    source_id: String,
    temp_mailbox_id: String,
    provider_message_id: String,
    received_address: String,
    now: String,
) -> MessageSource {
    MessageSource {
        id: format!("msrc_{}", Uuid::new_v4()),
        message_id,
        source_id,
        account_id: None,
        temp_mailbox_id: Some(temp_mailbox_id),
        provider_message_id: Some(provider_message_id),
        received_address: Some(received_address),
        first_seen_at: now.clone(),
        last_seen_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::message::Message;
    use crate::domain::temp_mailbox::TempMailbox;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;
    use crate::storage::temp_mailbox_repository::insert_temp_mailbox;

    #[test]
    fn message_source_keeps_temp_mailbox_id() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let temp = TempMailbox::new_anonymous(
            "code@example.test".to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &temp).expect("insert temp mailbox");

        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id,
                    source_kind,
                    provider_id,
                    status,
                    created_at,
                    updated_at
                ) VALUES ('src_1', 'easyemail_temp', 'fake', 'ready', '2026-06-11T00:00:00Z', '2026-06-11T00:00:00Z')",
                [],
            )
            .expect("insert source");

        let message = Message::new(
            "Your code is 123456".to_string(),
            "noreply@example.test".to_string(),
            "Code 123456".to_string(),
            "2026-06-11T00:00:01Z".to_string(),
        );
        insert_message(&connection, &message).expect("insert message");

        let source = create_temp_message_source(
            message.id.clone(),
            "src_1".to_string(),
            temp.id.clone(),
            "provider_msg_1".to_string(),
            "code@example.test".to_string(),
            "2026-06-11T00:00:02Z".to_string(),
        );
        insert_message_source(&connection, &source).expect("insert message source");

        let stored_temp_id: String = connection
            .query_row(
                "SELECT temp_mailbox_id FROM message_sources WHERE message_id = ?1",
                params![message.id],
                |row| row.get(0),
            )
            .expect("select temp mailbox id");

        assert_eq!(stored_temp_id, temp.id);
    }
}
```

Modify `src-tauri/src/storage/mod.rs`:

```rust
pub mod account_repository;
pub mod db;
pub mod message_repository;
pub mod migrations;
pub mod temp_mailbox_repository;
```

- [x] **Step 2: Run message source invariant test**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml message_source_keeps_temp_mailbox_id
```

Expected:

```text
test result: ok
```

- [x] **Step 3: Commit message source invariant**

Run:

```powershell
git add src-tauri/src/storage
git commit -m "feat: preserve message source trace"
```

Expected:

```text
[master
```

or:

```text
[main
```

---

## Task 8: Add AppState, health command, and minimal UI

**Files:**
- Create: `src-tauri/src/app_state.rs`
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [x] **Step 1: Create AppState and health command**

Create `src-tauri/src/app_state.rs`:

```rust
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{AppError, ErrorCategory};
use crate::storage::account_repository::ensure_anonymous_virtual_account;
use crate::storage::db::open_database;
use crate::storage::migrations::run_migrations;
use crate::time::now_rfc3339;

pub struct AppState {
    pub database_path: PathBuf,
    pub connection: Mutex<Connection>,
}

impl AppState {
    pub fn open_default() -> Result<Self, AppError> {
        let data_dir = std::env::current_dir()
            .map_err(|err| AppError {
                code: "data_dir_unavailable".to_string(),
                category: ErrorCategory::Storage,
                user_message: "The application data directory is unavailable.".to_string(),
                technical_message: Some(err.to_string()),
                retryable: false,
                action_required: crate::error::ActionRequired::None,
                correlation_id: uuid::Uuid::new_v4().to_string(),
                metadata: serde_json::json!({}),
            })?
            .join(".easyemailam");

        fs::create_dir_all(&data_dir).map_err(|err| AppError {
            code: "data_dir_create_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The application data directory could not be created.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: crate::error::ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: serde_json::json!({ "path": data_dir.display().to_string() }),
        })?;

        let database_path = data_dir.join("easyemailam.sqlite");
        let connection = open_database(&database_path).map_err(|err| AppError {
            code: "sqlite_open_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The local database could not be opened.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: crate::error::ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: serde_json::json!({ "path": database_path.display().to_string() }),
        })?;

        run_migrations(&connection).map_err(|err| AppError {
            code: "sqlite_migration_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The local database schema could not be prepared.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: crate::error::ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: serde_json::json!({}),
        })?;

        ensure_anonymous_virtual_account(&connection, now_rfc3339()).map_err(|err| AppError {
            code: "anonymous_account_init_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The anonymous mailbox account could not be initialized.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: crate::error::ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: serde_json::json!({}),
        })?;

        Ok(Self {
            database_path,
            connection: Mutex::new(connection),
        })
    }
}
```

Create `src-tauri/src/commands.rs`:

```rust
use serde::Serialize;

use crate::app_state::AppState;
use crate::error::{ActionRequired, AppError, ErrorCategory, ErrorDto};
use crate::storage::account_repository::{ensure_anonymous_virtual_account, list_normal_accounts};
use crate::time::now_rfc3339;

#[derive(Debug, Clone, Serialize)]
pub struct HealthDto {
    pub status: String,
    pub database_path: String,
    pub anonymous_account_id: String,
    pub normal_account_count: usize,
}

#[tauri::command]
pub fn health_check(state: tauri::State<'_, AppState>) -> Result<HealthDto, ErrorDto> {
    let connection = state.connection.lock().map_err(|err| {
        AppError {
            code: "sqlite_connection_lock_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The local database is temporarily unavailable.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: true,
            action_required: ActionRequired::Retry,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: serde_json::json!({}),
        }
        .to_dto()
    })?;

    let anonymous_account_id = ensure_anonymous_virtual_account(&connection, now_rfc3339())
        .map_err(|err| {
            AppError {
                code: "anonymous_account_init_failed".to_string(),
                category: ErrorCategory::Storage,
                user_message: "The anonymous mailbox account could not be initialized.".to_string(),
                technical_message: Some(err.to_string()),
                retryable: false,
                action_required: ActionRequired::None,
                correlation_id: uuid::Uuid::new_v4().to_string(),
                metadata: serde_json::json!({}),
            }
            .to_dto()
        })?;

    let normal_account_count = list_normal_accounts(&connection)
        .map_err(|err| {
            AppError {
                code: "normal_account_list_failed".to_string(),
                category: ErrorCategory::Storage,
                user_message: "The account list could not be loaded.".to_string(),
                technical_message: Some(err.to_string()),
                retryable: true,
                action_required: ActionRequired::Retry,
                correlation_id: uuid::Uuid::new_v4().to_string(),
                metadata: serde_json::json!({}),
            }
            .to_dto()
        })?
        .len();

    Ok(HealthDto {
        status: "ready".to_string(),
        database_path: state.database_path.display().to_string(),
        anonymous_account_id,
        normal_account_count,
    })
}
```

- [x] **Step 2: Wire Tauri builder**

Replace `src-tauri/src/lib.rs` with:

```rust
pub mod app_state;
pub mod commands;
pub mod domain;
pub mod error;
pub mod redaction;
pub mod storage;
pub mod time;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = app_state::AppState::open_default().expect("initialize EasyEmailAM app state");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![commands::health_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [x] **Step 3: Replace frontend with a health screen**

Replace `src/App.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type HealthDto = {
  status: string;
  database_path: string;
  anonymous_account_id: string;
  normal_account_count: number;
};

type ErrorDto = {
  code: string;
  user_message: string;
  correlation_id: string;
};

function asErrorDto(value: unknown): ErrorDto {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<ErrorDto>;
    return {
      code: typeof candidate.code === "string" ? candidate.code : "unknown_error",
      user_message:
        typeof candidate.user_message === "string"
          ? candidate.user_message
          : "EasyEmailAM could not complete the request.",
      correlation_id:
        typeof candidate.correlation_id === "string" ? candidate.correlation_id : "unknown",
    };
  }

  return {
    code: "unknown_error",
    user_message: "EasyEmailAM could not complete the request.",
    correlation_id: "unknown",
  };
}

function App() {
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [error, setError] = useState<ErrorDto | null>(null);

  useEffect(() => {
    invoke<HealthDto>("health_check")
      .then((result) => {
        setHealth(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        setError(asErrorDto(caught));
        setHealth(null);
      });
  }, []);

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">EasyEmailAM Foundation</p>
        <h1>Mailbox aggregation starts with a safe local core.</h1>
        <p className="lede">
          This build verifies Tauri startup, SQLite migrations, the anonymous virtual
          mailbox invariant, and the command boundary.
        </p>
      </section>

      <section className="status-card" aria-live="polite">
        <h2>Foundation status</h2>
        {health ? (
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{health.status}</dd>
            </div>
            <div>
              <dt>Anonymous account</dt>
              <dd>{health.anonymous_account_id}</dd>
            </div>
            <div>
              <dt>Visible normal accounts</dt>
              <dd>{health.normal_account_count}</dd>
            </div>
            <div>
              <dt>Database path</dt>
              <dd>{health.database_path}</dd>
            </div>
          </dl>
        ) : error ? (
          <div className="error-panel">
            <strong>{error.code}</strong>
            <span>{error.user_message}</span>
            <small>Correlation: {error.correlation_id}</small>
          </div>
        ) : (
          <p>Loading local foundation status...</p>
        )}
      </section>
    </main>
  );
}

export default App;
```

Replace `src/App.css` with:

```css
:root {
  color: #f7fbff;
  background: #10182a;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  background:
    radial-gradient(circle at top left, rgba(74, 144, 226, 0.42), transparent 34rem),
    linear-gradient(135deg, #10182a 0%, #111827 48%, #192339 100%);
}

button,
input {
  font: inherit;
}

.app-shell {
  display: grid;
  gap: 2rem;
  max-width: 1040px;
  margin: 0 auto;
  padding: 5rem 2rem;
}

.hero,
.status-card {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(18px);
}

.hero {
  padding: 3rem;
}

.eyebrow {
  margin: 0 0 0.75rem;
  color: #8bd3ff;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  max-width: 780px;
  margin-bottom: 1rem;
  font-size: clamp(2.4rem, 7vw, 5.4rem);
  line-height: 0.95;
}

.lede {
  max-width: 700px;
  margin-bottom: 0;
  color: rgba(247, 251, 255, 0.76);
  font-size: 1.15rem;
  line-height: 1.7;
}

.status-card {
  padding: 2rem;
}

dl {
  display: grid;
  gap: 1rem;
  margin: 0;
}

dl > div {
  display: grid;
  grid-template-columns: minmax(160px, 0.28fr) 1fr;
  gap: 1rem;
  align-items: start;
  padding: 1rem;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.08);
}

dt {
  color: rgba(247, 251, 255, 0.62);
  font-weight: 700;
}

dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.error-panel {
  display: grid;
  gap: 0.5rem;
  padding: 1rem;
  border: 1px solid rgba(255, 107, 107, 0.4);
  border-radius: 18px;
  background: rgba(255, 107, 107, 0.14);
}
```

- [x] **Step 4: Run frontend and Rust checks**

Run:

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected:

```text
npm run build exits 0
test result: ok
Finished `dev` profile
```

- [x] **Step 5: Commit command and UI foundation**

Run:

```powershell
git add src-tauri/src src/App.tsx src/App.css
git commit -m "feat: wire foundation health command"
```

Expected:

```text
[master
```

or:

```text
[main
```

---

## Task 9: Final verification for the Foundation slice

**Files:**
- Validate all created and modified files.
- No source edits in this task unless a verification command identifies a concrete failure.

- [x] **Step 1: Run the official verification script**

Run:

```powershell
npm run verify
```

Expected:

```text
npm run build exits 0
cargo fmt exits 0
cargo test exits 0
cargo check exits 0
```

- [x] **Step 2: Verify no secret-like content is emitted by tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml redacts_ app_error_serialization_has_code_category_user_message -- --nocapture
```

Expected:

```text
test result: ok
```

The output must not contain:

```text
abc123
def456
password=secret
refresh_token=def456
```

- [x] **Step 3: Verify repository invariants**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml ensure_anonymous_virtual_account_is_idempotent normal_account_query_excludes_agent_accounts upgrade_temp_mailbox_transaction_creates_account_and_updates_visibility message_source_keeps_temp_mailbox_id
```

Expected:

```text
test result: ok
```

- [x] **Step 4: Inspect final git state**

Run:

```powershell
git status --short --branch
git log --oneline --max-count 8
```

Expected:

```text
## master
```

or:

```text
## main
```

The log should include these commits:

```text
feat: wire foundation health command
feat: preserve message source trace
feat: add foundation repositories
feat: add sqlite foundation schema
feat: add foundation domain models
feat: add error and redaction foundation
chore: normalize project metadata
chore: scaffold tauri foundation
```

- [x] **Step 5: Record the foundation completion note**

Append this entry to `docs/superpowers/plans/2026-06-11-easyemailam-foundation.md` only after all verification commands pass:

```markdown
## Foundation execution record

- Scaffold path used: `.bootstrap/easyemailam-template`
- Verification command: `npm run verify`
- Required invariants covered:
  - anonymous virtual account is idempotent
  - agent accounts are excluded from normal account queries
  - temp mailbox upgrade creates a normal upgraded account
  - message source trace keeps `temp_mailbox_id`
  - error DTO metadata is redacted
```

Then commit the execution record:

```powershell
git add docs/superpowers/plans/2026-06-11-easyemailam-foundation.md
git commit -m "docs: record foundation verification"
```

Expected:

```text
[master
```

or:

```text
[main
```

---

## Self-review checklist for this plan

Spec coverage:

- Milestone 0 project skeleton: Task 1 and Task 2.
- Rust AppState: Task 8.
- SQLite initialization and migration runner: Task 5 and Task 8.
- Uniform AppError: Task 3 and Task 8.
- Redaction skeleton: Task 3 and Task 9.
- Anonymous virtual account creation: Task 4, Task 6, and Task 8.
- Repository invariants for normal account listing, temp mailbox persistence, temp upgrade, and message source trace: Task 6 and Task 7.
- Minimal frontend health command path: Task 8.
- Verification gate: Task 9.

Type consistency:

- `AccountScope::Agent` serializes as `agent`, matching the SQL `scope` check.
- `AccountKind::AnonymousVirtual` serializes as `anonymous_virtual`, matching the SQL `kind` check.
- `TempVisibilityState::Anonymous` serializes as `anonymous`, matching the SQL `visibility_state` check.
- `TempLifecycleState::Active` serializes as `active`, matching the SQL `lifecycle_state` check.
- `ErrorDto` fields match the TypeScript `ErrorDto` fields in `src/App.tsx`.
- `HealthDto` fields match the TypeScript `HealthDto` fields in `src/App.tsx`.

Execution handoff:

Plan complete and saved to `docs/superpowers/plans/2026-06-11-easyemailam-foundation.md`.

Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints.

## Foundation execution record

- Scaffold path used: `.bootstrap/easyemailam-template`
- Verification command: `npm run verify`
- Required invariants covered:
  - anonymous virtual account is idempotent
  - agent accounts are excluded from normal account queries
  - temp mailbox upgrade creates a normal upgraded account
  - message source trace keeps `temp_mailbox_id`
  - error DTO metadata is redacted
