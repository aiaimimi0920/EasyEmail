# Frontend Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract EasyEmailAM frontend pure logic from `App.tsx` without changing user-visible behavior or command wiring.

**Architecture:** Start with a dependency-free generic mail selector module and Node's built-in TypeScript test runner. Keep React state and JSX in `App.tsx`; replace local pure functions with imports only after tests define the current behavior. Later phases repeat the same extraction pattern for compose data and Tauri command wrappers.

**Tech Stack:** React 19, TypeScript 5.8, Vite 7, Node 22 built-in test runner, Tauri 2, Rust.

---

## File structure

- Create `src/mail/mailSelectors.ts`
  - Pure generic date, sorting, attachment, and conversation selectors.
- Create `tests/mailSelectors.test.ts`
  - Behavioral tests using `node:test` and `node:assert/strict`.
- Modify `src/App.tsx`
  - Import selector functions and remove duplicate local implementations.
- Modify `package.json`
  - Add `test:unit` and include it in the frontend verification path.
- Modify `scripts/verify-neuroterminal-ui.mjs`
  - Verify App uses the extracted selector module instead of local duplicates.

---

### Task 1: Establish the zero-dependency frontend unit-test command

**Files:**
- Create: `tests/mailSelectors.test.ts`
- Modify: `package.json`

- [x] **Step 1: Add the test command**

Add:

```json
"test:unit": "node --test tests/mailSelectors.test.ts"
```

- [x] **Step 2: Write tests against the desired selector API**

Import these functions from `../src/mail/mailSelectors.ts`:

```ts
buildMailConversations
normalizeMailConversationSubject
sortMailListMessages
sortVisibleMailMessagesByTime
visibleMailMessageSortTimestamp
```

Cover timestamp comments, sorting modes, persisted thread keys, fallback grouping, draft isolation, and aggregate flags.

- [x] **Step 3: Run the test and verify RED**

Run:

```powershell
npm run test:unit
```

Expected: failure because `src/mail/mailSelectors.ts` does not exist.

---

### Task 2: Implement the generic mail selector module

**Files:**
- Create: `src/mail/mailSelectors.ts`
- Test: `tests/mailSelectors.test.ts`

- [x] **Step 1: Define structural selector types**

Define exported types for sortable messages, mail-list messages, conversation messages, sort modes, and generic conversation summaries. Do not import React or application DTOs.

- [x] **Step 2: Implement the minimal functions required by the tests**

Move the current behavior from `App.tsx` without semantic changes. Preserve deterministic message-ID tie breaking and RFC thread-key precedence.

- [x] **Step 3: Run the test and verify GREEN**

Run:

```powershell
npm run test:unit
```

Expected: all mail selector tests pass.

---

### Task 3: Switch App.tsx to the extracted selectors

**Files:**
- Modify: `src/App.tsx`
- Modify: `scripts/verify-neuroterminal-ui.mjs`

- [x] **Step 1: Add selector imports**

Import the tested functions and generic conversation-summary type from `src/mail/mailSelectors.ts`.

- [x] **Step 2: Remove duplicate local implementations**

Delete only the functions now supplied by the module. Keep search, mailbox classification, and React-specific behavior local in this phase.

- [x] **Step 3: Strengthen static verification**

Require the selector import and reject local duplicate declarations.

- [x] **Step 4: Verify the frontend**

Run:

```powershell
npm run test:unit
npm run ui:verify
npm run build
```

Expected: all commands pass and the production bundle builds.

---

### Task 4: Release regression gate

**Files:**
- No source changes expected.

- [x] **Step 1: Verify Rust and formatting**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

- [x] **Step 2: Build and smoke-test the release**

Run:

```powershell
npm run tauri -- build
node artifacts/ui-audit/2026-07-24/cdp-runtime-smoke.mjs
```

Expected: release builds and the existing main/compose/contact interaction smoke passes.

---

### Task 5: Prepare the next extraction batch

**Files:**
- Modify: `docs/superpowers/specs/2026-07-24-frontend-decomposition-design.md`
- Create later: `src/compose/composeData.ts`
- Create later: `tests/composeData.test.ts`

- [x] **Step 1: Record selector extraction results**

Record final line-count reduction, test count, and any behavior discovered during extraction.

- [x] **Step 2: Define the compose-data API from existing call sites**

Limit the next batch to emoji data/search, recipient normalization, and draft snapshot serialization. Keep DOM selection commands in `App.tsx`.

---

### Task 6: Extract the contact Tauri client boundary

**Files:**
- Create: `src/api/contactClient.ts`
- Create: `tests/contactClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `package.json`
- Modify: `scripts/verify-neuroterminal-ui.mjs`

- [x] **Step 1: Define the command contract with a failing test**

Test a dependency-injected client that calls `contact_list` without arguments and `contact_create` with exactly `{ request }`. Verify command names, payloads, and returned DTOs with a typed fake invoke implementation.

- [x] **Step 2: Implement the minimal typed client**

Export `ContactDto`, `ContactCreateRequest`, `InvokeCommand`, and `createContactClient`. Do not import React or application state and do not add a compatibility wrapper.

- [x] **Step 3: Move only contact call sites**

Replace the two direct `contact_list` calls and one direct `contact_create` call in `App.tsx`. Keep bootstrap ordering, state updates, contact-modal behavior, and all non-contact `invoke` calls unchanged.

- [x] **Step 4: Strengthen static verification and run frontend gates**

Require the extracted client, reject direct contact invokes in `App.tsx`, and run the focused test, all frontend unit tests, UI verification, and the production frontend build.

---

### Task 7: Extract the EasyEmail settings Tauri client boundary

**Files:**
- Create: `src/api/settingsClient.ts`
- Create: `tests/settingsClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `package.json`
- Modify: `scripts/verify-neuroterminal-ui.mjs`

- [x] **Step 1: Define all three settings command contracts with failing tests**

Test `settings_get_easyemail` without arguments plus the exact `{ request }` wrappers for `settings_update_easyemail` and `settings_test_easyemail`.

- [x] **Step 2: Implement the minimal typed settings client**

Export the settings DTO, connection-health DTO, update request, connection-test request, and a dependency-injected client factory. Preserve nullable service URL and API-token values.

- [x] **Step 3: Move only the three EasyEmail settings call sites**

Replace the initial settings load, save, and connection-test invokes. Keep all state updates, status messages, error handling, and non-settings commands unchanged.

- [x] **Step 4: Extend static verification and run frontend gates**

Require the settings client and reject ordinary direct calls to the three extracted settings commands from `App.tsx`.

---

### Task 8: Extract the shared invoke type and send-queue Tauri client

**Files:**
- Create: `src/api/invokeCommand.ts`
- Create: `src/api/sendQueueClient.ts`
- Create: `tests/sendQueueClient.test.ts`
- Modify: `src/api/contactClient.ts`
- Modify: `src/api/settingsClient.ts`
- Modify: `tests/contactClient.test.ts`
- Modify: `tests/settingsClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `package.json`
- Modify: `scripts/verify-neuroterminal-ui.mjs`

- [x] **Step 1: Define the send-queue command contracts with failing tests**

Cover queue listing, targeted item execution, one-shot worker execution, due-batch execution, exact argument envelopes, result propagation, and rejection propagation.

- [x] **Step 2: Move `InvokeCommand` to a neutral API transport module**

Update contact, settings, send-queue clients and their tests to import the shared type without introducing runtime dependencies or compatibility re-exports.

- [x] **Step 3: Implement and integrate the send-queue client**

Move `SendQueueDto`, `SendQueueWorkerRunResult`, the two limit requests, and the queue-item request. Replace only the two list calls plus run-item, run-once, and run-due-batch calls in `App.tsx`.

- [x] **Step 4: Strengthen verification and run all gates**

Update scheduled-send and direct-send static checks to use the client boundary, reject direct `send_queue_*` invokes in `App.tsx`, and run focused tests, all frontend tests, UI verification, build, Rust checks, release build, and CDP smoke.

---

### Task 9: Extract the mail-taxonomy Tauri client

**Files:**
- Create: `src/api/mailTaxonomyClient.ts`
- Create: `tests/mailTaxonomyClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `package.json`
- Modify: `scripts/verify-neuroterminal-ui.mjs`

- [x] **Step 1: Define taxonomy command contracts with failing tests**

Cover folder/label listing, upsert, update, delete, nullable parent IDs, exact request envelopes, DTO return values, and rejection propagation.

- [x] **Step 2: Implement the minimal typed taxonomy client**

Export the taxonomy kind, item/delete DTOs, four request types, and a dependency-injected client using the neutral `InvokeCommand` module.

- [x] **Step 3: Move only the five taxonomy call sites**

Replace the two list calls plus upsert, update, and delete. Keep tree construction, descendant checks, modal state, confirmation, reload ordering, selection, toasts, and message refresh logic in `App.tsx`.

- [x] **Step 4: Strengthen verification and run all gates**

Update existing folder/label assertions to read command ownership from the client, reject direct taxonomy invokes in `App.tsx`, and run focused tests, the complete repository verification path, release build, and folder/label CDP smoke.

---

### Task 10: Extract the newsletter-subscription Tauri client

**Files:**
- Create: `src/api/newsletterClient.ts`
- Create: `tests/newsletterClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `package.json`
- Modify: `scripts/verify-neuroterminal-ui.mjs`

- [x] **Step 1: Define newsletter command contracts with failing tests**

Cover subscription listing, hidden-state updates including `hidden: false`, exact `{ request }` envelopes, full DTO/action return values, and unchanged rejection propagation.

- [x] **Step 2: Implement the minimal typed newsletter client**

Export the subscription/action DTOs, list/set-hidden request types, and a dependency-injected client using the neutral `InvokeCommand` module. Preserve the exact `newsletter_subscription_list` and `newsletter_subscription_set_hidden` command names.

- [x] **Step 3: Move only the three newsletter call sites**

Replace the direct single-account list, account-map list, and set-hidden calls. Keep cache construction, selected-subscription state, hide/restore cleanup, unsubscribe handling, reload ordering, toasts, and errors in `App.tsx`.

- [x] **Step 4: Strengthen verification and run all gates**

Move newsletter DTO/command ownership checks to the typed client, reject direct newsletter subscription invokes in `App.tsx`, run focused and complete repository verification, build release artifacts, and extend CDP smoke with a read-only Newsletters mailbox check.

---

### Task 11: Extract the platform-account Tauri client

**Files:**
- Create: `src/api/platformAccountClient.ts`
- Create: `tests/platformAccountClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `package.json`
- Modify: `scripts/verify-neuroterminal-ui.mjs`

- [x] **Step 1: Define platform-account command contracts with failing tests**

Cover the no-argument session command, query resources, exact `{ request }` query envelopes, complete nested session/query DTOs, unknown query payloads, and unchanged rejection propagation.

- [x] **Step 2: Implement the minimal typed platform-account client**

Export the account, usage, endpoint, session, query-resource, query-request, and query-result types plus a dependency-injected client using the neutral `InvokeCommand` module. Preserve the exact `platform_account_get_session` and `platform_account_query_data` commands.

- [x] **Step 3: Move only the four platform-account call sites**

Replace the initial session load, query-data call, session refresh after a session query, and preview sign-in session load. Keep React state, signed-in state, popover behavior, status/error handling, and query sequencing in `App.tsx`.

- [x] **Step 4: Strengthen verification and run all gates**

Move platform-account DTO/command ownership to the typed client, reject direct platform-account invokes and command literals in `App.tsx`, run focused and complete repository verification, build release artifacts, and extend CDP smoke with a read-only platform-account popover check.

---

### Task 12: Extract the avatar-settings Tauri client

**Files:**
- Create: `src/api/avatarSettingsClient.ts`
- Create: `tests/avatarSettingsClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `package.json`
- Modify: `scripts/verify-neuroterminal-ui.mjs`
- Modify: `artifacts/ui-audit/2026-07-24/cdp-runtime-smoke.mjs`

- [x] **Step 1: Define the three avatar-settings command contracts with failing tests**

Cover the no-argument settings load, exact `{ request }` envelopes for settings updates and cache clearing, `include_contacts: false`, returned-value identity, and unchanged rejection propagation.

- [x] **Step 2: Implement the minimal typed avatar-settings client**

Export the settings DTO, update request, cache-clear request/result DTOs, and a dependency-injected client using the neutral `InvokeCommand` module. Preserve the exact `avatar_get_settings`, `avatar_update_settings`, and `avatar_clear_cache` commands without transformations or error wrapping.

- [x] **Step 3: Move only the three avatar-settings call sites**

Replace the initial settings load, settings save, and cache clear calls. Keep React state, sender-avatar cache invalidation, success text, error conversion, busy/finally behavior, checkbox UI, and both cache-clear modes in `App.tsx`. Leave sender resolution and contact-avatar commands for a later batch.

- [x] **Step 4: Strengthen verification and run all gates**

Assign the moved DTO/command ownership to the typed client, reject direct scoped invokes and command literals in `App.tsx`, run focused and complete repository verification, build release artifacts, and extend CDP smoke with read-only avatar-settings controls plus a scrolled action screenshot.
