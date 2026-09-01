# EasyEmailAM Design Spec

Date: 2026-06-11

Status: design approved for review

## 1. Background and goal

EasyEmailAM is a desktop email aggregation and management application for human users. It is not a replacement for EasyEmail and it is not a provider implementation layer.

The product boundary is:

```text
EasyEmailAM = human-facing mailbox aggregation, temporary-mailbox management, verification-code workflow, and mail-driven Agent UI
EasyEmail   = provider capability, temporary mailbox creation/fetching, target-service/provider selection, SDK/service layer
```

EasyEmailAM must call EasyEmail through a stable adapter. It must not copy EasyEmail provider implementations, provider health ranking, target-service filtering, or provider-specific selection logic.

The preferred technical baseline is:

```text
Rust + Tauri + SQLite + system Keychain + EasyEmail Adapter
```

The core user value is:

```text
Connect EasyEmail, create temporary mailboxes, aggregate anonymous temporary mailbox mail, extract verification codes, and promote important temporary mailboxes into independently managed accounts while preserving lifecycle truth and local security.
```

The secondary product value is:

```text
Use user-owned Agent mailbox accounts to send task emails to remote Agent email services, then collect replies as task threads without mixing Agent mail into normal human mail.
```

## 2. Non-goals

Version 1 must not attempt to become a full Thunderbird or Mailspring replacement.

Explicit non-goals:

```text
Complete multi-folder deep synchronization
Advanced tag system
Advanced rule engine
Cross-device cloud sync
Team collaboration
PGP/S/MIME
Full attachment manager
Complex search syntax
Built-in Agent execution runtime
Remote Agent platform
Agent RPC
Webhook task protocol
MCP task protocol
WebSocket task protocol
Copying EasyEmail provider logic into EasyEmailAM
Maintaining provider health ranking inside EasyEmailAM
Maintaining target-service provider selection inside EasyEmailAM
```

The first product proof should be:

```text
create temporary mailbox -> receive code mail -> aggregate in anonymous mailbox -> extract/copy verification code -> optionally promote the mailbox
```

## 3. Overall architecture

The application is split into five conceptual layers:

```text
Frontend UI
  Normal mail module
  Anonymous/temporary mailbox module
  Verification code module
  Agent mailbox module
  Settings and diagnostics

Tauri Command API
  Stable request/response boundary used by the frontend

Rust Application Core
  AccountService
  MessageService
  SyncService
  TempMailboxService
  VerificationCodeService
  AgentMailboxService
  SendQueueService
  SecretService
  DiagnosticsService

Adapter Layer
  EasyEmailAdapter
  ImapAdapter
  SmtpAdapter
  OAuthAdapter
  SecretVaultAdapter

Infrastructure
  SQLite
  Windows Credential Manager / macOS Keychain / Linux Secret Service
  Optional local encrypted vault
  Local cache
  Logs and diagnostics
```

Top-level product modules are strictly separated:

```text
Normal mail module
  Long-lived normal accounts
  Anonymous virtual mailbox
  Promoted temporary mailboxes
  Verification-code views

Agent mailbox module
  User-owned Agent mailbox accounts
  Remote Agent email services
  Agent task threads
  Agent replies and notifications
```

Agent mailbox accounts do not appear in normal "all accounts". Remote Agent services are not accounts.

## 4. Core data model

The data model must keep UI accounts, real synchronization sources, credentials, provider metadata, messages, and Agent entities separate.

### 4.1 Account

`Account` is the visible account unit in the UI.

Important fields:

```text
accounts
  id
  scope
  kind
  display_name
  primary_address
  provider_label
  status
  auth_status
  receive_status
  send_status
  listed_in_all_accounts
  created_at
  updated_at
  disabled_at
  deleted_at
```

`scope`:

```text
normal
agent
system
```

`kind`:

```text
normal_long_lived
normal_upgraded_temp
anonymous_virtual
agent_owned
```

Rules:

```text
normal_long_lived      = user-added human mailbox such as Gmail, Outlook, QQ, 163, custom IMAP
normal_upgraded_temp   = temporary mailbox promoted into a normal visible account
anonymous_virtual      = system virtual account aggregating unpromoted temporary mailboxes
agent_owned            = user-owned mailbox used only for the Agent module
```

The normal "all accounts" query must include:

```text
scope = normal
or kind = anonymous_virtual
```

It must exclude:

```text
scope = agent
agent_services
archived temp mailboxes
deleted accounts
```

### 4.2 Account status

A single account status is not enough. Status is split into:

```text
status
auth_status
receive_status
send_status
```

`status`:

```text
ready
configuring
syncing
degraded
disabled
history_only
deleted
```

`auth_status`:

```text
not_required
valid
expired
invalid
missing
refreshing
reauthorization_required
```

`receive_status`:

```text
enabled
syncing
backoff
auth_failed
provider_unavailable
expired
disabled
unsupported
```

`send_status`:

```text
enabled
sending
queued_only
auth_failed
smtp_unavailable
rate_limited
disabled
unsupported
```

This lets the UI represent conditions such as:

```text
Can receive but cannot send
OAuth expired but history is readable
Temporary mailbox expired but history remains searchable
Agent mailbox can send but remote Agent has not replied
```

### 4.3 MailboxSource

`MailboxSource` is the actual synchronization or send/receive source behind an account.

```text
mailbox_sources
  id
  account_id
  source_kind
  address
  provider_id
  credential_ref_id
  connection_profile_id
  status
  last_sync_at
  last_success_at
  last_error_code
  last_error_message
  created_at
  updated_at
```

`source_kind`:

```text
imap
smtp
easyemail_temp
anonymous_virtual
agent_imap
agent_smtp
```

A long-lived normal account usually has IMAP and SMTP sources. An anonymous virtual account has no real IMAP/SMTP source. A promoted temporary account points back to an EasyEmail temporary source.

### 4.4 CredentialRef

SQLite never stores secret values directly.

```text
credential_refs
  id
  owner_account_id
  source_id
  secret_backend
  secret_key
  credential_kind
  auth_method
  status
  created_at
  updated_at
  last_verified_at
```

`secret_backend`:

```text
windows_credential_manager
macos_keychain
linux_secret_service
local_encrypted_vault
```

`credential_kind`:

```text
imap_password
smtp_password
app_password
oauth_access_token
oauth_refresh_token
oauth_client_secret
easyemail_session_token
provider_api_token
```

Only `secret_key` and metadata are stored in SQLite. Passwords, tokens, OAuth refresh tokens, and provider session tokens live in the system Keychain or optional encrypted vault.

### 4.5 TempMailbox

Temporary mailboxes are not normal accounts by default.

```text
temp_mailboxes
  id
  email_address
  provider_id
  provider_label
  domain
  local_part
  easyemail_mailbox_id
  source_id
  visibility_state
  capability
  lifecycle_state
  lease_expires_at
  renewable_until
  last_fetch_at
  last_success_at
  upgraded_account_id
  raw_provider_snapshot_json
  created_at
  updated_at
  archived_at
```

`visibility_state`:

```text
anonymous
upgraded
archived
hidden
```

`capability`:

```text
persistent
renewable
fixed_ttl
receive_only
send_receive
unknown
```

`lifecycle_state`:

```text
active
expiring
expired
receive_unavailable
provider_unavailable
history_only
```

Promotion is a UI management change, not a provider lifecycle change:

```text
visibility_state: anonymous -> upgraded
upgraded_account_id: null -> new normal account id
```

Messages are not moved or copied.

### 4.6 Message and MessageSource

`Message` stores the message body and common metadata.

```text
messages
  id
  rfc_message_id
  thread_key
  subject
  from_address
  from_name
  date_sent
  date_received
  snippet
  body_text_cache
  body_html_cache
  body_cache_state
  has_attachments
  size_bytes
  classification
  security_flags
  created_at
  updated_at
  deleted_at
```

`MessageSource` stores source-specific identity and ownership.

```text
message_sources
  id
  message_id
  source_id
  account_id
  folder_id
  temp_mailbox_id
  provider_message_id
  imap_uid
  imap_uidvalidity
  easyemail_message_id
  received_address
  flags_json
  first_seen_at
  last_seen_at
```

For anonymous temporary mail:

```text
message_sources.temp_mailbox_id = temp_mailbox.id
UI ownership is derived from temp_mailbox.visibility_state
```

### 4.7 Folder

Version 1 keeps folder support small:

```text
mail_folders
  id
  account_id
  source_id
  folder_kind
  provider_folder_id
  display_name
  path
  delimiter
  sync_enabled
  last_sync_at
  uidvalidity
  created_at
  updated_at
```

`folder_kind`:

```text
inbox
sent
drafts
archive
trash
spam
custom
virtual
```

Default synchronization should be limited to important folders such as INBOX, Sent, Drafts, and Trash.

### 4.8 VerificationCode

Verification codes are extracted from messages into a separate query-friendly view.

```text
verification_codes
  id
  message_id
  account_scope
  received_address
  code
  issuer_hint
  target_service_hint
  confidence
  expires_at
  extracted_at
```

Version 1 can use rule-based extraction:

```text
4-8 digit codes
common verification keywords
issuer hints from sender and subject
target_service hints from temp mailbox creation
```

### 4.9 Agent entities

Remote Agent services are not accounts.

```text
agent_services
  id
  display_name
  email_address
  description
  service_kind
  trust_level
  default_sender_account_id
  status
  created_at
  updated_at
  deleted_at
```

`trust_level`:

```text
unknown
trusted
restricted
blocked
```

Agent task threads:

```text
agent_threads
  id
  agent_service_id
  sender_account_id
  subject
  status
  last_outgoing_message_id
  last_incoming_message_id
  correlation_key
  created_at
  updated_at
  completed_at
```

`status`:

```text
draft
sent
awaiting_reply
in_progress
completed
failed
expired
needs_attention
archived
```

Agent message index:

```text
agent_messages
  id
  thread_id
  message_id
  direction
  semantic_role
  parsed_status
  parsed_payload_json
  created_at
```

### 4.10 SyncState and SendQueue

Synchronization is tracked at source/folder/job level, not only account level.

```text
sync_states
  id
  source_id
  folder_id
  sync_kind
  status
  cursor_json
  last_started_at
  last_success_at
  last_failure_at
  failure_count
  next_retry_at
  last_error_code
  last_error_message
```

`sync_kind`:

```text
imap_folder
smtp_send_queue
easyemail_temp_fetch
agent_inbox
```

Send queue:

```text
send_queue
  id
  account_id
  source_id
  message_id
  target_address
  status
  attempt_count
  next_retry_at
  last_error_code
  last_error_message
  created_at
  sent_at
```

## 5. Core invariants

These invariants must be enforced by domain/service/repository tests.

```text
Agent mailboxes never appear in normal all accounts.
Anonymous mailbox is a virtual system account, not a real mailbox.
Temporary mailbox promotion does not change provider lifecycle.
Promotion never moves or copies messages.
Every message keeps source traceability.
Secrets never enter SQLite as plaintext.
Secrets never enter DTOs or logs.
EasyEmail provider internals do not become EasyEmailAM core logic.
AgentService is not Account.
Blocked AgentService cannot send tasks.
```

## 6. Core workflows

### 6.1 App startup

Startup sequence:

```text
Open config
Open SQLite
Run migrations
Initialize secret backend
Ensure anonymous virtual account
Load account summaries
Restore last UI state
Start background scheduler
Schedule lightweight health checks
```

Startup must not perform full historical synchronization. It should load local summaries first and then schedule incremental jobs.

### 6.2 Add normal mailbox

Version 1 supports manual IMAP/SMTP first, then OAuth/provider presets later.

Manual flow:

```text
User selects provider or custom IMAP
User enters email, IMAP profile, optional SMTP profile, and credential
AccountService validates connection
SecretService stores secret in Keychain
AccountService creates Account and MailboxSource records
SyncService schedules initial sync
UI shows account status
```

IMAP success and SMTP failure can be saved as receive-only:

```text
receive_status = enabled
send_status = auth_failed or smtp_unavailable
status = degraded
```

### 6.3 IMAP synchronization

Initial sync:

```text
Discover folders
Create mail_folders
Sync bounded recent headers
Save messages and message_sources
Run lightweight verification extraction
Update sync_state
Emit UI events
```

Version 1 should fetch a bounded number of recent headers and fetch body/attachments on demand.

Incremental sync:

```text
Load sync_state
Connect IMAP
Select folder
Fetch UIDs after cursor
Save new messages
Update cursor
Classify new mail
Emit events
```

If `UIDVALIDITY` changes:

```text
Keep local history
Reset folder cursor
Bounded rescan
Deduplicate by Message-ID and fallback keys
```

### 6.4 Create temporary mailbox

UI request:

```text
target_service optional
provider_selection
domain_selection
local_part optional
note optional
wait_for_code bool
```

Service flow:

```text
TempMailboxService.create_temp_mailbox
  -> EasyEmailAdapter.resolve_candidates
  -> EasyEmailAdapter.create_temp_mailbox
  -> normalize canonical fields
  -> create mailbox_source(source_kind=easyemail_temp)
  -> create temp_mailbox(visibility_state=anonymous)
  -> schedule fetch
  -> if wait_for_code then schedule high-frequency polling
  -> emit temp_mailbox_created
```

Creation failures must not create partial temp mailbox records unless a deliberate attempt history feature is introduced.

### 6.5 Anonymous mailbox aggregation

Anonymous mailbox shows:

```text
temp_mailboxes.visibility_state = anonymous
```

Message query:

```text
Find anonymous temp mailboxes
Join message_sources by temp_mailbox_id
Join messages
Sort by date_received desc
Attach received_address, provider_label, lifecycle state, and code summary
```

Refresh anonymous mailbox:

```text
Find active anonymous temp mailboxes
Schedule fetch for each
Apply provider-level concurrency limits
Store new messages
Extract codes
Update temp mailbox status independently
```

Expired temporary mailboxes remain visible as history unless archived.

### 6.6 Waiting for verification code

When a temporary mailbox is created for a service registration, the UI can enter waiting mode.

Polling policy:

```text
First 2 minutes: about every 5 seconds
2-10 minutes: about every 15 seconds
After 10 minutes: lower frequency
Stop or lower frequency when a code is detected or mailbox expires
```

Provider-level limits must override polling frequency.

On detection:

```text
Save verification_codes
Emit verification_code_detected
Show large code
Allow one-click copy
Open original mail if needed
```

### 6.7 Promote temporary mailbox

Promotion flow:

```text
Load temp_mailbox
Validate visibility_state = anonymous
Create Account(scope=normal, kind=normal_upgraded_temp)
Set account status from temp mailbox lifecycle
Set temp_mailbox.visibility_state = upgraded
Set temp_mailbox.upgraded_account_id = new account id
Update source/account binding if needed
Emit temp_mailbox_upgraded
```

The UI must clearly say:

```text
Promotion moves the mailbox out of anonymous aggregation and into the normal account list.
Promotion does not make the provider mailbox permanent.
```

### 6.8 Send normal mail

Sending uses `send_queue`.

```text
Create draft
Validate account can send
Enqueue message
SendQueueWorker sends via SmtpAdapter
Update status queued -> sending -> sent or failed
Retry retryable failures with backoff
```

Anonymous virtual accounts and receive-only temporary mailboxes cannot send.

### 6.9 Agent task mail

Agent task flow:

```text
User creates Agent task draft
Validate sender account scope = agent
Validate AgentService trust_level
Create agent_thread
Create outgoing message
Create agent_message(direction=outgoing)
Enqueue send
On send success set thread status = awaiting_reply
```

Restricted services require explicit confirmation. Blocked services reject send.

### 6.10 Agent reply association

When an Agent mailbox receives a message:

```text
Save message
Inspect as possible Agent reply
Try linking by In-Reply-To / References
Try X-EasyEmailAM-Thread-ID if present
Try sender + normalized subject
Try participants + time window fallback
Unmatched known-Agent mail enters needs_attention
```

Agent replies are indexed through `agent_messages` and displayed in Agent task detail. They do not appear in normal all accounts.

## 7. Frontend information architecture

The recommended top-level navigation:

```text
Normal Mail
Anonymous Mailbox
Verification Codes
Agent Mailbox
Settings
```

Desktop layout:

```text
Top bar
  Search
  Create temporary mailbox
  Compose
  Sync status
  Settings

Left sidebar
  Modules and accounts

Middle list
  Messages, temp mailboxes, codes, tasks, or settings list

Right detail panel
  Message detail, temp mailbox detail, code detail, task detail, or settings detail
```

### 7.1 Normal mail

Normal mail sidebar contains:

```text
All accounts
Anonymous mailbox
Normal long-lived accounts
Promoted temporary accounts
```

It excludes Agent accounts.

Promoted temporary account detail must display:

```text
provider
capability
lifecycle state
expiry time
history-only warning if expired
```

### 7.2 Anonymous mailbox

Anonymous mailbox page includes:

```text
Summary
Temporary mailbox list
Aggregated mail list
Recent codes
```

Every anonymous mail row must show:

```text
sender
subject
verification tag
real received temporary address
provider
time
temporary mailbox lifecycle state
```

### 7.3 Create temporary mailbox

Default modal is simple:

```text
target_service optional
note optional
create
```

Advanced fields are folded:

```text
provider
domain
local_part
wait_for_code
```

Default:

```text
provider = automatic
domain = automatic
local_part = automatic
wait_for_code = true
```

### 7.4 Verification codes

Recent codes show:

```text
code
issuer_hint
received_address
source account
received_at
expires_at
confidence
copy action
open original mail
```

Notifications should not display the full code by default.

### 7.5 Agent mailbox

Agent module contains:

```text
Agent tasks
Agent replies
My Agent mailboxes
Remote Agent services
```

Agent task detail shows:

```text
status
remote Agent service
sender account
outgoing task mail
incoming replies
manual status actions
open original mail actions
```

### 7.6 Settings

Settings sections:

```text
Mailbox accounts
EasyEmail connection
Security and credentials
Sync and cache
Agent settings
Notifications
Diagnostics and logs
About
```

Diagnostics must default to redacted output.

## 8. Rust/Tauri backend design

Recommended backend structure:

```text
src-tauri/src/
  main.rs
  app_state.rs
  bootstrap.rs
  commands/
  dto/
  domain/
  services/
  repositories/
  adapters/
  workers/
  storage/
  errors/
  events/
  diagnostics/
  config/
  security/
```

Layer responsibilities:

```text
commands/       Tauri command entrypoints only
dto/            frontend request/response types
domain/         business entities, enums, invariants, state transitions
services/       business workflow orchestration
repositories/   SQLite access and transactions
adapters/       EasyEmail, IMAP, SMTP, OAuth, Keychain boundaries
workers/        background sync/fetch/send/classification/monitor jobs
storage/        SQLite pool, migrations, transaction helpers
errors/         AppError and ErrorCode
events/         Tauri event schema
diagnostics/    health checks and diagnostic export
security/       redaction and secret handling
```

Commands must not contain business logic or SQL. Repositories must not decide product policy. Adapters must not create accounts or write product state.

### 8.1 AppState

Prefer a shared state containing repositories, adapters, config, and event bus:

```text
AppState
  db
  repos
  adapters
  event_bus
  config
```

Services can be constructed as lightweight values from shared dependencies. This avoids a large circular service container and makes tests easier.

### 8.2 Command API

Command groups:

```text
account_*
message_*
temp_*
verification_*
agent_*
sync_*
settings_*
diagnostics_*
```

Important commands:

```text
account_list_normal_accounts
account_list_agent_accounts
account_validate_manual_connection
account_create_manual
account_delete

temp_create_mailbox
temp_list_mailboxes
temp_refresh_mailbox
temp_refresh_anonymous
temp_upgrade_mailbox
temp_archive_mailbox

message_list
message_get_detail
message_search

verification_list_recent
verification_reclassify_message

agent_add_service
agent_list_services
agent_create_task_draft
agent_send_task
agent_list_threads
agent_get_thread_detail

sync_get_status
sync_run_now

settings_test_easyemail
settings_get
settings_update

diagnostics_get_summary
diagnostics_export
```

All command errors serialize to a stable error DTO:

```text
code
category
user_message
retryable
action_required
correlation_id
```

### 8.3 Adapter traits

`EasyEmailAdapter`:

```text
health_check
list_provider_capabilities
resolve_candidates
create_temp_mailbox
fetch_temp_messages
renew_temp_mailbox
```

`ImapAdapter`:

```text
test_connection
discover_folders
fetch_recent_headers
fetch_incremental
fetch_message_body
```

`SmtpAdapter`:

```text
test_connection
send_message
```

`OAuthAdapter`:

```text
build_authorization_url
exchange_code
refresh_token
revoke_token
```

`SecretVaultAdapter`:

```text
save_secret
load_secret
delete_secret
exists
```

Each adapter needs a fake implementation for service tests.

### 8.4 Worker runtime

Workers:

```text
SyncScheduler
ImapSyncWorker
TempMailboxFetchWorker
SendQueueWorker
VerificationExtractionWorker
AgentThreadMonitor
CredentialRefreshWorker
```

Job kinds:

```text
SyncAccount
SyncFolder
FetchTempMailbox
RefreshAnonymousMailbox
SendQueuedMessage
ExtractVerificationCode
InspectAgentMessage
RefreshCredential
MonitorAgentThreads
```

Version 1 can use an in-memory job queue plus SQLite-persisted sync and send state.

Concurrency limits:

```text
Global IMAP: small fixed limit
Per-account IMAP: 1
EasyEmail fetch: small fixed limit
Per-provider EasyEmail fetch: 1-2
SMTP send: small fixed limit
```

### 8.5 Events

Core emits lightweight Tauri events:

```text
account_status_changed
sync_job_started
sync_job_finished
message_received
verification_code_detected
temp_mailbox_created
temp_mailbox_status_changed
temp_mailbox_upgraded
send_queue_updated
agent_thread_updated
agent_reply_received
diagnostic_warning
```

Events carry IDs and summary state, not full message bodies or secrets.

## 9. Error, logging, and diagnostics

Unified error:

```text
AppError
  code
  category
  user_message
  technical_message
  retryable
  action_required
  correlation_id
  metadata
```

Categories:

```text
auth
network
provider
protocol
storage
validation
rate_limit
unsupported
internal
```

Sensitive values are redacted at both error creation/logging and diagnostic export.

Never log:

```text
passwords
authorization codes
OAuth access tokens
OAuth refresh tokens
provider tokens
full message bodies by default
full verification codes by default
attachments by default
```

Diagnostics summary includes:

```text
app_version
db_path
cache_path
sqlite_status
keychain_status
easyemail_status
account_status_counts
sync_queue_counts
send_queue_counts
recent_errors
worker_status
```

Diagnostic export defaults:

```text
include logs
include account metadata with redaction
include provider snapshots if redacted
exclude message bodies
exclude attachments
exclude secrets
```

## 10. MVP scope

### 10.1 MVP-Core

MVP-Core must prove:

```text
Temporary mailbox creation
Anonymous aggregation
Verification code extraction
Temporary mailbox promotion
Local secure credential handling
Clear status and diagnostics
```

Must include:

```text
Tauri app startup
SQLite migrations
Anonymous virtual account
EasyEmail connection settings
EasyEmail health check
Create temporary mailbox
Anonymous temporary mailbox aggregation
Fetch temporary mailbox messages
Verification code extraction
Recent codes list
Promote temporary mailbox
Promoted account message view
Temporary mailbox lifecycle status
Basic diagnostics and redacted logging
```

Strongly recommended:

```text
Manual IMAP account add
Normal mailbox message list/detail
Sync status panel
Cross-source recent verification codes
```

Deferred:

```text
OAuth
Full SMTP sending
Attachments
Advanced folder sync
Full-text search
Complete encrypted vault
Agent module
```

### 10.2 MVP-Agent

MVP-Agent follows after MVP-Core and send queue foundations.

Must include:

```text
User-owned Agent mailbox account
Agent account excluded from normal all accounts
Remote Agent service
trust_level
Agent task draft
SMTP/send_queue task send
AgentThread status model
IMAP reply collection
Reply association by headers and subject fallback
Unmatched replies in needs_attention
```

## 11. Milestones

### Milestone 0: project skeleton and baseline

Scope:

```text
Tauri skeleton
SQLite init
Migration runner
AppState
AppError
EventBus
Logging/redaction skeleton
Health command
```

Acceptance:

```text
App starts
SQLite database is created
Migrations are repeatable
Anonymous virtual account is ensured
Frontend can call health command
Errors return stable ErrorDto
Logs redact test secrets
```

Required tests:

```text
migrations_apply_cleanly
ensure_anonymous_virtual_account_is_idempotent
app_error_serialization_has_code_category_user_message
redaction_removes_secret_like_fields
```

### Milestone 1: core schema and repositories

Scope:

```text
accounts
mailbox_sources
credential_refs
temp_mailboxes
messages
message_sources
sync_states
verification_codes
app_settings
repositories for those tables
```

Acceptance:

```text
Normal account can be created
Agent account can be created but is excluded from normal list
Anonymous virtual account exists
Temp mailbox can be created
Messages and message_sources can be saved
Anonymous aggregation query works
Promotion transaction works
```

Required tests:

```text
normal_account_query_excludes_agent_accounts
anonymous_virtual_account_scope_is_system
temp_mailbox_default_visibility_is_anonymous
upgrade_temp_mailbox_transaction_creates_account_and_updates_visibility
message_source_keeps_temp_mailbox_id
```

### Milestone 2: EasyEmail adapter and temporary mailbox creation

Scope:

```text
EasyEmailAdapter trait
HTTP adapter
Fake adapter
settings_test_easyemail
temp_create_mailbox
temp_list_mailboxes
basic temp mailbox UI
```

Acceptance:

```text
User can configure EasyEmail service URL
Connection test works
Temporary mailbox can be created
Created mailbox defaults to anonymous
Failure shows user-readable error
EasyEmail tokens are not logged
```

Required tests:

```text
easyemail_health_success_maps_to_dto
easyemail_unreachable_maps_to_retryable_error
create_temp_mailbox_saves_canonical_fields
create_temp_mailbox_stores_raw_snapshot_without_core_dependency
provider_rate_limit_returns_rate_limit_error
```

### Milestone 3: temporary mailbox fetch and anonymous aggregation

Scope:

```text
EasyEmailAdapter.fetch_temp_messages
TempMailboxFetchWorker
temp_refresh_mailbox
temp_refresh_anonymous
message_list scope=anonymous
anonymous mailbox UI
message deduplication
```

Acceptance:

```text
Anonymous refresh fetches active anonymous temp mailboxes
New messages are saved
Anonymous list shows all anonymous temp mailbox mail
Rows show real received address and provider
Repeated fetch does not duplicate messages
Expired mailboxes become expired/history_only without deleting history
```

Required tests:

```text
refresh_anonymous_fetches_only_active_anonymous_mailboxes
fetch_temp_messages_inserts_messages_and_sources
fetch_temp_messages_is_idempotent
expired_temp_mailbox_is_skipped_unless_forced
anonymous_message_query_excludes_upgraded_temp_mailbox
```

### Milestone 4: verification codes and waiting mode

Scope:

```text
VerificationCodeService
lightweight classification
verification_list_recent
verification_reclassify_message
waiting-for-code polling
copy-code UI
source traceability
```

Acceptance:

```text
New verification-code mail creates verification_codes record
Recent code list shows code, issuer, received address, source mail
Waiting mode highlights detected code
User can copy code
Code detail opens original mail
Logs do not store full code by default
```

Required tests:

```text
extracts_common_6_digit_verification_code
extracts_code_from_subject_or_body
associates_code_with_temp_mailbox_received_address
recent_codes_can_filter_by_temp_mailbox
verification_code_not_logged_plain_by_default
```

### Milestone 5: promote temporary mailbox

Scope:

```text
temp_upgrade_mailbox
normal_upgraded_temp account
promotion confirmation UI
promoted account page
anonymous query exclusion for promoted mailboxes
history-only state
```

Acceptance:

```text
User can promote anonymous temp mailbox
Normal account list shows promoted mailbox
Anonymous mailbox no longer shows that temp mailbox mail
Promoted account shows historical messages
Messages are not moved or copied
Expired temp mailbox promotion displays history_only or degraded
UI explains promotion does not change true lifetime
```

Required tests:

```text
upgrade_temp_mailbox_creates_normal_upgraded_temp_account
upgrade_does_not_move_or_rewrite_messages
anonymous_query_excludes_upgraded_mailbox_messages
upgraded_account_query_includes_historical_messages
expired_temp_upgrade_results_in_history_only_account
```

### Milestone 6: normal IMAP basics

Scope:

```text
Manual IMAP add
SecretVaultAdapter fake and Windows Credential Manager adapter
Fake/real ImapAdapter skeleton
Connection test
Initial recent-header sync
Normal message list/detail
Account status display
```

Acceptance:

```text
User can add manual IMAP normal mailbox
Credential is stored in Keychain
SQLite stores only credential_ref
Account appears in normal account list
Initial sync fetches recent summaries
Auth failure shows requires-action status
Agent accounts remain excluded from normal list
```

Required tests:

```text
manual_account_create_saves_credential_ref_not_secret
normal_account_initial_sync_saves_messages
imap_auth_failure_sets_auth_failed_status
list_normal_accounts_excludes_agent_accounts
message_detail_does_not_expose_secret_metadata
```

### Milestone 7: SMTP and send queue

Scope:

```text
SMTP adapter
send_queue
draft/send commands
SendQueueWorker
send status UI
retry/backoff
```

Acceptance:

```text
Supported normal account can send mail
Sending uses send_queue
UI does not block on SMTP
Success marks sent
Retryable failure backs off
Auth failure requires user action
Anonymous and receive-only accounts cannot send
```

Required tests:

```text
send_message_requires_send_enabled
anonymous_account_cannot_send
smtp_retryable_error_requeues_with_backoff
smtp_auth_failure_sets_action_required
send_queue_worker_is_idempotent
```

### Milestone 8: Agent mailbox MVP

Scope:

```text
Agent account scope
agent_services
agent_threads
agent_messages
Add remote Agent service
Create Agent task
Send task mail
Collect Agent replies
Reply linking
needs_attention unmatched replies
```

Acceptance:

```text
User can add Agent mailbox account
Agent mailbox does not appear in normal all accounts
User can add remote Agent service
User can create and send Agent task mail
restricted service requires confirmation
blocked service rejects send
Agent reply links by mail headers where possible
Unmatched known-Agent reply enters needs_attention
Task detail displays mail thread
```

Required tests:

```text
agent_account_is_not_listed_in_normal_accounts
agent_task_requires_agent_scope_sender
blocked_agent_service_rejects_send
restricted_agent_service_requires_confirmation
incoming_reply_links_by_in_reply_to
unmatched_agent_reply_goes_to_needs_attention
```

## 12. Testing strategy

Testing layers:

```text
Domain unit tests
Service tests with fake repositories/adapters
Repository tests with temporary SQLite
Adapter contract tests with fake/mock servers
Command tests
Worker tests
Error/redaction tests
Integration smoke tests
Frontend interaction tests later
```

Domain tests cover invariants:

```text
anonymous_virtual_must_be_system_scope
agent_owned_is_not_visible_in_normal_all_accounts
anonymous_temp_mailbox_can_upgrade
expired_temp_mailbox_upgrade_creates_history_only_account
blocked_agent_service_cannot_send
restricted_agent_service_requires_confirmation
```

Service tests cover workflows:

```text
create_temp_mailbox_defaults_to_anonymous_visibility
upgrade_temp_mailbox_does_not_move_messages
refresh_anonymous_skips_expired_mailboxes
manual_account_create_saves_secret_ref_not_secret
incoming_reply_links_by_in_reply_to
```

Repository tests cover real SQL and transactions:

```text
migrations_apply_cleanly
ensure_anonymous_virtual_account_is_idempotent
list_normal_accounts_excludes_agent_accounts
upgrade_temp_mailbox_transaction_is_atomic
message_dedup_by_easyemail_message_id
agent_message_unique_thread_message
```

Redaction tests are mandatory:

```text
app_error_serialization_does_not_include_secret
logs_redact_password_fields
logs_redact_oauth_tokens
diagnostic_export_excludes_message_body_by_default
verification_code_not_logged_plain_by_default
```

Integration smoke tests:

```text
app_bootstrap_runs_migrations
anonymous_virtual_account_created
temp_mailbox_flow_with_fake_easyemail
upgrade_temp_mailbox_flow
manual_account_flow_with_fake_imap_smtp
agent_task_flow_with_fake_smtp_and_fake_imap_reply
```

## 13. Risk register and mitigations

### 13.1 Scope expands into a full mail client

Risk:

```text
Advanced folders, tags, rules, HTML composition, attachment management, and complex search delay the core temporary-mailbox product.
```

Mitigation:

```text
Keep v1 folder support bounded.
Fetch bodies and attachments on demand.
Defer tags, rules, and complex search.
Prioritize temporary mailbox, anonymous aggregation, and verification codes.
```

### 13.2 EasyEmail provider logic is copied into EasyEmailAM

Risk:

```text
EasyEmailAM starts ranking providers, filtering target services, or relying on raw provider internals.
```

Mitigation:

```text
Use EasyEmailAdapter canonical fields only.
Let EasyEmail service own provider selection and health.
Store raw snapshots only for diagnostics and compatibility.
```

### 13.3 Temporary mailbox promotion misleads users

Risk:

```text
Users think a promoted temporary mailbox is permanent.
```

Mitigation:

```text
Promotion confirmation explains lifecycle.
Promoted account header shows provider, capability, expiry, and history-only state.
Expired promoted mailboxes never display as fully ready.
```

### 13.4 Agent mail leaks into normal mail

Risk:

```text
Agent accounts or Agent replies appear in normal all accounts.
```

Mitigation:

```text
AccountScope is enforced in domain, repository, and service layers.
Repository normal-list methods exclude agent scope by default.
AgentService is a separate entity, not Account.
```

### 13.5 Credential leakage

Risk:

```text
Passwords, tokens, authorization codes, verification codes, or message bodies appear in SQLite, logs, DTOs, or diagnostic exports.
```

Mitigation:

```text
SecretService and SecretVaultAdapter are mandatory.
SQLite stores only credential refs.
DTOs never expose secrets.
Logs and diagnostics use redaction.
Redaction tests are mandatory.
```

### 13.6 Background synchronization is uncontrolled

Risk:

```text
Full sync on startup, too many IMAP connections, provider rate limits, untracked failures, or lingering tasks.
```

Mitigation:

```text
Use sync_states, concurrency limits, exponential backoff, cancellation tokens, and diagnostic worker status.
High-frequency polling only applies to waiting-for-code mode.
```

### 13.7 Message duplication or history loss

Risk:

```text
Repeated fetches duplicate messages; promotion moves messages incorrectly; provider IDs are unstable.
```

Mitigation:

```text
Separate Message from MessageSource.
Use multi-level deduplication.
Promotion changes only visibility and account linkage.
Keep history unless user explicitly deletes it.
```

### 13.8 Tauri commands become a business-logic dump

Risk:

```text
Commands directly run SQL, call HTTP, parse IMAP, and mutate state.
```

Mitigation:

```text
Commands only map DTO -> service -> DTO.
SQL lives in repositories.
External systems live in adapters.
Business workflows live in services.
```

### 13.9 Tests cover only happy paths

Risk:

```text
Failures, retries, scope isolation, redaction, expired mailboxes, and duplicate messages are not tested.
```

Mitigation:

```text
Every milestone has required tests.
Domain and redaction tests are mandatory from the beginning.
Repository tests use real SQLite.
Service tests use fake adapters for failure paths.
```

## 14. Allowed and disallowed technical debt

Allowed short-term debt:

```text
Rule-based verification-code extraction before ML/AI classification
Manual IMAP before OAuth
Minimal HTML mail rendering
No automatic attachment download
In-memory worker queue plus SQLite state
Handwritten TypeScript DTO types
Encrypted vault reserved for later if system Keychain is in place
```

Not allowed:

```text
Plaintext secrets in SQLite
Secrets in DTOs or logs
Agent mail in normal all accounts
Promotion shown as permanent mailbox conversion
EasyEmail provider logic copied into EasyEmailAM
Message source traceability lost
Promotion implemented by moving or copying messages
Untested migrations
Unredacted diagnostics
```

## 15. Recommended implementation order

The implementation order should be:

```text
1. Project skeleton, migration, AppError, redaction
2. Core schema and repositories
3. EasyEmail connection and temporary mailbox creation
4. Temporary mailbox fetch and anonymous aggregation
5. Verification-code extraction and waiting mode
6. Temporary mailbox promotion
7. Manual IMAP normal mailbox support
8. SMTP send queue
9. Agent mailbox MVP
10. OAuth, attachments, search, encryption vault, richer diagnostics
```

The first user-valuable alpha is:

```text
EasyEmail temporary mailbox + anonymous mailbox + verification code extraction
```

That alpha proves the distinctive value before investing in full normal-mail or Agent features.

## 16. Final acceptance summary

MVP-Core is acceptable when:

```text
User can configure EasyEmail.
User can create a temporary mailbox.
Mailbox appears in anonymous mailbox.
System can fetch and display mail for that mailbox.
System extracts verification codes and supports one-click copy.
User can promote important temporary mailboxes.
Promoted mailbox shows historical messages without moving/copying message rows.
Expired mailboxes remain honest as expired/history_only.
Secrets are stored outside SQLite plaintext.
Errors and diagnostics are understandable and redacted.
```

MVP-Agent is acceptable when:

```text
User can add an Agent mailbox account.
Agent mailbox is excluded from normal all accounts.
User can add a remote Agent email service.
User can send a task email through a user-owned Agent mailbox.
Replies are associated with task threads when possible.
Unmatched replies enter needs_attention.
Blocked/restricted trust levels are enforced.
```

## 17. Next step after spec review

After this design spec is reviewed and accepted, the next process step is to create a detailed implementation plan. The implementation plan should decompose milestones into small tasks with file-level targets, tests, and validation commands.

No implementation should start until this spec has been reviewed and the implementation plan has been written.
