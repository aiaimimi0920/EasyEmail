# EasyEmailAM Frontend Decomposition Design

Date: 2026-07-24

Status: approved for incremental implementation

## 1. Goal

Reduce the structural and regression risk of the 11,000+ line `src/App.tsx` without changing the current user interface, DOM hierarchy, CSS selectors, Tauri command names, persisted data, or runtime behavior.

The refactor follows a strangler-style sequence: extract pure and testable logic first, then typed command boundaries, and only then consider React component boundaries.

## 2. Current evidence

The current frontend has:

- 11,699 lines in `src/App.tsx`
- 131 `useState` calls
- 24 `useEffect` calls
- 80 asynchronous functions
- 91 typed Tauri `invoke` calls
- one primary React component containing mail, compose, contacts, settings, queue, and Agent workflows

The immediate risk is not a single known defect. It is that unrelated changes share one compilation and render scope, making behavior-preserving edits increasingly difficult to review and test.

## 3. Invariants

Every extraction must preserve these contracts:

1. Existing CSS class names and DOM nesting remain unchanged unless a separate UI task explicitly approves a change.
2. Tauri command names, request shapes, and response shapes remain unchanged.
3. `App.tsx` remains the owner of application state during the first phases.
4. No compatibility wrappers are retained after all call sites move to the extracted implementation.
5. Every extracted pure function receives focused unit tests before the production call site is changed.
6. `npm run ui:verify`, `npm run build`, Rust tests, and release runtime smoke remain the final regression gates.

## 4. Target modules

### 4.1 Mail selectors

Create `src/mail/mailSelectors.ts` for pure mail calculations:

- robust message timestamp parsing
- newest/oldest/size sorting
- attachment heuristics
- normalized conversation subjects
- RFC thread-key and fallback conversation grouping
- unread, starred, and verification-code conversation summaries

The module uses structural generic types so it does not import React, Tauri, or `App.tsx`.

### 4.2 Compose domain data

After mail selectors are stable, create focused compose modules for:

- emoji catalogue and keyword search
- draft snapshot serialization helpers
- recipient parsing and normalization
- formatting option constants

Editor DOM commands stay in the React component until their selection and focus behavior has dedicated browser coverage.

### 4.3 Typed Tauri client

Create a typed frontend command layer after pure functions are extracted. It will group commands by domain while preserving the exact existing command strings and payloads.

### 4.4 React components

Component extraction is intentionally last. Candidate boundaries are MailTopbar, MailListToolbar, MailReadingPane, ComposePopover, and ContactModal. A component moves only when its inputs and callbacks can be expressed without duplicating state.

## 5. Error handling

Pure selector modules do not throw for malformed dates or missing optional fields. They retain the current fallback behavior:

- invalid dates sort as timestamp zero
- stable message IDs break sorting ties
- drafts remain isolated conversations
- persisted RFC thread keys take priority over subject heuristics
- attachment detection remains heuristic and non-destructive

## 6. Testing strategy

Use the Node 22 built-in test runner with native TypeScript stripping. Tests live outside `src` so the browser TypeScript configuration does not require Node type declarations.

The first test suite covers:

- RFC 2822 dates containing timezone comments
- deterministic newest and oldest sorting
- deterministic largest and smallest sorting
- repeated Re/Fw subject normalization
- persisted thread-key grouping
- fallback subject and counterparty grouping
- draft isolation
- conversation unread, starred, and verification-code summaries

Static UI verification remains responsible for DOM and interaction contracts. CDP smoke remains responsible for release WebView behavior.

## 7. Rollout

Each phase is independently reversible:

1. Add tests and mail selector module.
2. Switch `App.tsx` to imports and delete the duplicate local functions.
3. Verify production and release behavior.
4. Repeat the same pattern for compose data.
5. Add the typed Tauri client.
6. Reassess whether React component extraction still provides enough benefit.

No phase requires a simultaneous full-file rewrite.

## 8. First extraction result

The mail selector batch completed with no UI or command changes:

- `App.tsx` reduced from 11,699 to 11,536 lines.
- `src/mail/mailSelectors.ts` now owns 222 lines of pure selector logic.
- `tests/mailSelectors.test.ts` adds eight focused behavior tests.
- The repository verification command now runs frontend unit tests before UI, build, and Rust checks.
- Release CDP smoke passed for the main mail view, compose window, contact picker, and compose-more menu.

The next approved batch is limited to compose emoji data/search and recipient normalization. Draft serialization moves only after its persisted shape has explicit parsing tests.

## 9. Second extraction result

The compose-data batch completed without moving React state, editor DOM commands, draft persistence, or Tauri command wiring:

- `App.tsx` reduced further from 11,536 to 11,190 lines, for a total reduction of 509 lines from the 11,699-line baseline.
- `src/compose/composeData.ts` now owns 339 lines of compose constants and pure behavior: font and color options, the nine-category emoji catalogue, emoji search and deduplication, recipient parsing/joining/normalization, contact-picker labels, and font fallback lookup.
- `tests/composeData.test.ts` adds eight focused tests, bringing the frontend unit-test total to 16.
- The Node test path imports the extracted TypeScript modules directly and adds no npm dependency.
- The enhanced release CDP smoke verified all nine emoji category tabs, `happy` search results (`😀` and `😂`), duplicate-free search output, the active `符号` category, and the expected `✅` symbol.
- Runtime screenshots `02b-compose-emoji-happy.png` and `02c-compose-emoji-symbols.png` confirm that the compose popover, search field, category controls, result grid, contrast, and anchoring remain visually intact after extraction.

The next approved batch is the smallest typed-Tauri boundary: contact listing and contact creation only. It must preserve the exact `contact_list` and `contact_create` command strings and their existing payload shapes before any other command domain moves.

## 10. Third extraction result

The first typed-Tauri boundary is now implemented for contacts only:

- `App.tsx` reduced from 11,190 to 11,182 lines, for a total reduction of 517 lines from the 11,699-line baseline.
- `src/api/contactClient.ts` adds a 30-line dependency-injected client with exported `ContactDto`, `ContactCreateRequest`, and `InvokeCommand` types.
- `tests/contactClient.test.ts` adds two command-contract tests, bringing the frontend unit-test total to 18.
- Both `contact_list` call sites and the single `contact_create` call site now use one module-scope client instance; no other Tauri invocation moved.
- The exact no-argument `contact_list` call and exact `{ request }` wrapper for `contact_create` are covered by the typed fake transport tests.
- Static verification rejects duplicate local contact DTOs and ordinary direct contact command invocations from `App.tsx`.
- Independent review found the batch specification-compliant and approved its code quality with no critical or important findings.
- Full repository verification passed: 18 frontend tests, static UI verification, TypeScript/Vite production build, Rust formatting, 173 Rust tests, and `cargo check`.

The source-text static verifier remains intentionally lightweight. It protects the ordinary refactor path but is not a substitute for a future AST-based architectural lint rule if the typed client surface expands substantially.

## 11. Fourth extraction result

The typed-Tauri boundary now also covers the three EasyEmail settings commands:

- `App.tsx` reduced from 11,182 to 11,174 lines, for a total reduction of 525 lines from the 11,699-line baseline.
- `src/api/settingsClient.ts` adds 46 lines defining settings/health DTOs, request types, and a dependency-injected client for get, update, and connection-test commands.
- `tests/settingsClient.test.ts` adds three command-contract tests, bringing the frontend unit-test total to 21.
- The initial settings load remains in the same `Promise.all` position, while save and connection-test flows retain their previous state updates, `optionalValue` calls, status messages, error handling, and busy-state cleanup.
- `settings_get_easyemail` still receives no argument object; both write/test commands preserve the exact `{ request }` wrapper and nullable connection-test values.
- Independent specification and code-quality reviews found no critical or important issue.
- Full verification passed again: 21 frontend tests, static UI verification, TypeScript/Vite production build, Rust formatting, 173 Rust tests, and `cargo check`.

At this stage `InvokeCommand` was reused through a type-only import from the contact client, with no runtime dependency. The next-client gate was therefore to move the shared transport type to a neutral `src/api` module rather than grow feature-to-feature type ownership.

## 12. Fifth extraction result

The third typed-Tauri domain now covers the send queue, and the shared transport type has moved to a neutral module:

- `App.tsx` reduced from 11,174 to 11,148 lines, for a total reduction of 551 lines from the 11,699-line baseline.
- `src/api/invokeCommand.ts` is the sole four-line owner of the generic invoke transport type; contact, settings, and send-queue clients import it with type-only dependencies and expose no compatibility re-exports.
- `src/api/sendQueueClient.ts` adds 60 lines for the queue DTO, worker result, request types, and four exact Tauri command methods.
- `tests/sendQueueClient.test.ts` adds six tests, bringing the frontend unit-test total to 27.
- Both queue-list call sites, targeted direct-send execution, manual worker execution, and periodic due-batch execution now use one module-scope send-queue client.
- The immediate scheduled-worker run, 15-second interval, overlap guard, cancellation checks, refresh ordering, direct-send feedback, and failure behavior remain in `App.tsx` unchanged.
- Contract tests cover exact commands and argument envelopes, no-argument one-shot execution, nullable limits and DTO fields, address arrays, returned-value identity, and unchanged rejection propagation.
- Independent specification and code-quality reviews found no critical or important issue. The easy test-quality suggestion from review was applied by explicitly asserting the `{ request: { limit: null } }` payload.
- Full verification passed: 27 frontend tests, static UI verification, TypeScript/Vite production build, Rust formatting, 173 Rust tests, and `cargo check`.
- Release CDP smoke passed across the main mailbox, compose, emoji search/categories, contact picker, compose-more menu, settings page, and send-queue page. The queue view rendered all nine current items plus its refresh/worker controls without executing either side-effecting action.
- Runtime screenshot `06-send-queue.png` confirms that the queue count, item states, sender form, and existing visual layout remained intact after moving the command boundary.

The remaining architectural verifier is intentionally lexical. The executable contract tests and TypeScript compilation are the authoritative checks for payload and return-type behavior; an AST-based rule remains optional future hardening rather than a prerequisite for continuing the incremental extraction.

## 13. Sixth extraction result

The fourth typed-Tauri domain now covers managed mail folders and labels without moving their React-owned behavior:

- `App.tsx` reduced from 11,148 to 11,129 lines, for a total reduction of 570 lines from the 11,699-line baseline.
- `src/api/mailTaxonomyClient.ts` adds 73 lines defining the folder/label kind, item/delete DTOs, four request types, and a dependency-injected client for list, upsert, update, and delete.
- `tests/mailTaxonomyClient.test.ts` adds seven command-contract tests, bringing the frontend unit-test total to 34.
- The two taxonomy list calls preserve their folder-then-label `Promise.all` ordering. Upsert, update, and delete preserve the exact `{ request }` envelope, nullable parent IDs, returned DTO identity, and rejection identity.
- Folder-tree construction, descendant-cycle prevention, form trimming, folder-parent versus label-null handling, modal state, confirmation, reload ordering, filter cleanup, toast/error handling, and rail animation remain in `App.tsx`.
- Static verification now assigns taxonomy type and command ownership to the typed client, rejects ordinary direct `mail_taxonomy_*` invokes from `App.tsx`, and retains the existing UI, Rust command, migration, and repository assertions.
- Independent specification and code-quality reviews approved the batch with no critical or important findings. The remaining minor notes are the known lexical verifier formatting sensitivity, one redundant inferred delete-result annotation, and a few harmless test-fixture assertions.
- Full repository verification passed: 34 frontend tests, static UI verification, TypeScript/Vite production build, Rust formatting, 173 Rust tests, and `cargo check`.
- The release build completed and produced the EXE plus MSI and NSIS bundles. The release EXE SHA-256 is `5213EFD450BD019D76AF0C724D7EB557DDE4E0A1F1C8051C5D29DCE832457EBF`.
- Release CDP smoke passed across the main mailbox, compose, emoji search/categories, contact picker, compose-more menu, settings, send queue, and the new read-only folder/label flows. The taxonomy checks observed two folders and two labels without creating, editing, deleting, or selecting user data.
- Runtime screenshots `07-folders.png` and `08-labels.png` confirm that collapsed-icon expansion, delayed action controls, mutually exclusive folder/label drawers, nested folder indentation, label indentation, colored taxonomy markers, and visible scroll affordances remain intact after the command-boundary extraction.

## 14. Seventh extraction result

The fifth typed-Tauri domain now covers newsletter subscription summaries and hidden-state updates:

- `App.tsx` reduced from 11,129 to 11,109 lines, for a total reduction of 590 lines from the 11,699-line baseline.
- `src/api/newsletterClient.ts` adds 52 lines defining the subscription/action DTOs, list/set-hidden requests, and a dependency-injected client for the two newsletter commands.
- `tests/newsletterClient.test.ts` adds three command-contract tests, bringing the frontend unit-test total to 37.
- Both subscription-list call sites preserve their original account IDs, `Promise.all` account ordering, cache construction, and state updates. The set-hidden call preserves the mutation, reload, selected-filter cleanup, toast, and error order.
- App-owned filtering, hidden-subscription visibility, unsubscribe URL handling, card selection, and message filtering remain in `App.tsx`; the client performs no trimming, conversion, catch, or state work.
- The first quality review rejected an unnecessary `satisfies Promise<NewsletterSubscriptionActionDto>` expression and the verifier rule that forced the unused App import. A verifier-first regression check failed on the old expression, then the App call and lexical boundary rule were simplified; quality re-review approved the result with no remaining critical or important finding.
- Static verification now counts exactly two list calls and one set-hidden call with whitespace-tolerant regular expressions, rejects the old `satisfies` expression, and rejects newsletter command literals from `App.tsx` while retaining the existing UI, Rust command, Tauri registration, and repository checks.
- Full repository verification passed after the review fix: 37 frontend tests, static UI verification, TypeScript/Vite production build, Rust formatting, 173 Rust tests, and `cargo check`.
- The release build produced the EXE plus MSI and NSIS bundles. The release EXE SHA-256 is `32B922F8D59AB53685CD305694994781B52B254FD6A7A4029A5897598D23161E`.
- Release CDP smoke opened the Newsletters mailbox read-only, verified the `订阅管理` panel and its valid empty state, returned to Inbox, and then completed the existing compose, settings, queue, folder, and label checks. The current mailbox contains newsletter-classified messages but no persisted List-ID/List-Unsubscribe subscription groups, so the panel correctly rendered zero cards without executing Hide, Restore, or Unsubscribe.
- Runtime screenshot `06b-newsletters.png` confirms that the newsletter management panel, empty-state guidance, newsletter message list, reading pane, compact rail, search bar, filters, and pagination remain visually intact after moving the command boundary.

## 15. Eighth extraction result

The sixth typed-Tauri domain now covers the development-preview platform account session and query API:

- `App.tsx` reduced from 11,109 to 11,070 lines, for a total reduction of 629 lines from the 11,699-line baseline.
- `src/api/platformAccountClient.ts` adds 73 lines defining the account, usage, endpoint, session, query-resource, query-request, and query-result types plus a dependency-injected client for the two platform-account commands.
- `tests/platformAccountClient.test.ts` adds three command-contract tests, bringing the frontend unit-test total to 40.
- The no-argument session command is covered explicitly, including the absence of an argument object and identity-preserving nested account, usage, endpoint, and endpoint-array results. The query test preserves the exact `{ request }` envelope and an `unknown` payload reference.
- The four App call sites preserve their original positions and sequencing: initial session load, resource query, conditional session refresh after a session query, and preview sign-in session load. React state, signed-in state, popover behavior, status/error messages, and busy/finally handling remain in `App.tsx`.
- Static verification now requires exactly three session calls and one query call through the client, rejects platform command literals and direct invokes from `App.tsx`, and retains the existing fake-service, Rust command, Tauri registration, and platform API documentation assertions.
- Independent specification and code-quality reviews approved the batch with no critical or important findings. The remaining minor notes are the known lexical verifier formatting sensitivity and that one successful query resource is sufficient for the branch-free wrapper even though all four resource literals are represented by the union type.
- Full repository verification passed: 40 frontend tests, static UI verification, TypeScript/Vite production build, Rust formatting, 173 Rust tests, and `cargo check`.
- The release build produced the EXE plus MSI and NSIS bundles. The release EXE SHA-256 is `8ED94FFCC19700FFEEEC0CA93818302BD45F0BD84D256635EF359FE8BDF878B0`.
- Release CDP smoke expanded the rail, opened the signed-in platform account popover, triggered the read-only profile query through the new client, verified `NMail Dev Account`, `dev.user@nmail.local`, and the sign-out control, then closed the popover without signing out or changing account data.
- Runtime screenshot `09-platform-account.png` confirms that the platform-account popover remains anchored to the expanded rail with readable account identity, development-preview status, and a clearly separated sign-out action after the command-boundary extraction.

## 16. Ninth extraction result

The seventh typed-Tauri domain now covers sender-avatar settings and cache management while leaving sender resolution and manual contact-avatar operations in their existing boundary:

- `App.tsx` reduced from 11,070 to 11,062 lines, for a total reduction of 637 lines from the 11,699-line baseline.
- `src/api/avatarSettingsClient.ts` adds 45 lines defining the settings DTO, update request, cache-clear request/result DTOs, and a dependency-injected client for three exact Tauri commands.
- `tests/avatarSettingsClient.test.ts` adds four command-contract tests, bringing the frontend unit-test total to 44.
- `avatar_get_settings` still receives no argument object. `avatar_update_settings` and `avatar_clear_cache` preserve the exact `{ request }` envelope, request identity, returned-value identity, `include_contacts: false`, and rejection identity.
- The initial load retains the same `Promise.all` position. Saving settings and clearing either remote-only or all avatar rows retain their original React state updates, sender-avatar map reset, status text, error conversion, and busy/finally ordering.
- `avatar_resolve_senders`, `avatar_set_contact`, `avatar_clear_contact`, `SenderAvatarDto`, upload preprocessing, editor positioning, resolver effects, and all avatar UI/DOM remain outside this batch.
- Static verification now assigns the three scoped commands and two moved App DTOs to the typed client, includes the client in neutral `InvokeCommand` ownership, and rejects direct scoped command calls or literals from `App.tsx` without broadening the rule to the excluded sender-avatar commands.
- Independent specification and code-quality reviews approved the batch with no critical, important, or minor findings.
- Full repository verification passed: 44 frontend tests, static UI verification, TypeScript/Vite production build, Rust formatting, 173 Rust tests, and `cargo check`.
- The release build produced the EXE plus MSI and NSIS bundles. The release EXE SHA-256 is `41A45633F6FB4B96AF03664F98E231B6AD55C7591920F9046AA4B1846D55A421`.
- Release CDP smoke verified the four persisted avatar-setting controls plus Save, Clear remote cache, and Clear all avatars without clicking any mutating action. It then completed the existing compose, contact, queue, newsletter, folder, label, and platform-account read-only flows.
- Runtime screenshots `05-settings.png` and `05b-avatar-settings-actions.png` confirm that the settings values load into the existing checkboxes, the three actions retain high contrast and spacing, the internal scroll behavior remains usable, and no surrounding setup layout shifted after the command-boundary extraction.

The next low-risk candidate is a separate sender-avatar client for `avatar_resolve_senders`, `avatar_set_contact`, and `avatar_clear_contact`. That batch should first reconcile the complete `SenderAvatarDto` transport shape, including the backend `auth` field, before moving any App call sites.
