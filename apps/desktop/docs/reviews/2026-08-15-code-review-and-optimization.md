# EasyEmailAM Code Review and Optimization Plan - 2026-08-15

## Purpose

This review examined the current `foundation` branch and then implemented the
highest-value correctness, security, performance, and maintainability fixes.
The review started from commit `34838bc` with a clean worktree. The changes in
this document are intentionally uncommitted so they can be inspected as one
reviewable optimization batch.

## Scope and method

The review covered:

- React state loading, mailbox filtering, rail counts, and frontend tests.
- Tauri command boundaries, service orchestration, repositories, and migrations.
- SQLite write atomicity and concurrent send-queue ownership.
- EasyEmail snapshots, verification-code polling, and newsletter queries.
- IMAP/SMTP security selection and send-worker terminal transitions.
- Remote avatar redirects, DNS resolution, and SSRF boundaries.
- Tauri content security policy and repository verification scripts.

The assessment used concrete call sites and tests rather than isolated helper
inspection. Independent passes covered backend correctness, data/security,
frontend behavior, and the final diff. Findings were then checked against the
exact code before changes were accepted.

## Findings addressed in this optimization batch

### P0 - correctness and security

- [x] **Make send-queue claims atomic.** Queue workers now claim one due row
  with `UPDATE ... RETURNING`, preventing two workers from owning the same send.
- [x] **Protect terminal queue transitions.** Sent, retry, authentication-failed,
  and failed transitions compare against `sending`; stale workers cannot
  overwrite a newer state.
- [x] **Recover from worker setup failures.** Failures after a claim but before
  transport execution now move the queue item out of `sending`.
- [x] **Make multi-row service writes transactional.** Message-plus-queue,
  agent task/reply associations, draft upserts, and temporary source creation
  now commit or roll back as one unit.
- [x] **Prevent cross-service agent reply association.** Outgoing reply lookup
  is constrained by the requested agent service.
- [x] **Reject plaintext mailbox authentication.** Native IMAP and SMTP accept
  only TLS or STARTTLS modes and infer security only for safe standard ports.
- [x] **Close remote-avatar SSRF gaps.** HTTPS-only remote lookups now validate
  every redirect, reject credentials and non-public addresses, resolve before
  each request, pin the validated socket addresses, ignore environment proxies,
  and enforce a redirect limit.
- [x] **Redact persisted provider evidence.** EasyEmail provider snapshots are
  redacted before SQLite persistence. Token/password data plus cookie,
  credential, private-key, and access-key fields are covered by tests.
- [x] **Compare lease timestamps semantically.** RFC 3339 timestamps are parsed
  before comparison, so different offsets no longer break expiry decisions.

### P1 - query behavior and maintainability

- [x] **Avoid returning an already-observed verification code.** Polling records
  the pre-poll code identity and returns only a newly observed result.
- [x] **Batch verification classification atomically.** Classification uses one
  transaction and direct message-by-ID reads instead of repeatedly listing a
  bounded message window.
- [x] **Move newsletter filtering into SQLite.** Newsletter message IDs are
  selected with `json_each` rather than materializing every message in Rust.
- [x] **Validate hidden newsletter overrides.** Arbitrary nonexistent message
  IDs can no longer be accepted as hidden overrides.
- [x] **Extract mailbox selectors from the application component.** Folder name
  normalization, built-in folder behavior, newsletter membership, filtering,
  and rail counts now live in `src/mail/mailSelectors.ts` with focused tests.
- [x] **Tighten newsletter semantics.** A message is a newsletter only through a
  backend subscription association or the exact `Newsletters` label; broad
  subject-keyword matching no longer creates false positives.
- [x] **Strengthen the desktop CSP.** The policy now denies base URI changes,
  embedded objects, form submissions, and framing.
- [x] **Replace the template README.** The repository now describes the actual
  product, architecture, commands, security boundaries, and verification gate.
- [x] **Extract stateless UI primitives.** Mail navigation, toolbar, search,
  compose-format, and brand SVGs now live in `src/components/AppIcons.tsx`,
  reducing `App.tsx` without changing workflow state or business behavior.
- [x] **Name editor color defaults at their owning boundary.** Rich-text defaults
  now live beside compose palette data, and taxonomy initialization uses the
  tested palette helper instead of duplicating a literal in `App.tsx`.

## Verification evidence

The optimization batch is accepted only when all of the following remain green:

1. `npm run verify`
   - Frontend Node tests: 96 passing.
   - NeuroTerminal UI contract verification: passing.
   - TypeScript and Vite production build: passing.
   - Production preview HTTP smoke: passing.
   - Rust format, Clippy (`-D warnings`), tests, and check: passing.
   - Rust tests after this batch: 228 passing.
2. `npm run tauri -- build --debug --no-bundle`
   - Produces the current debug desktop executable without installer bundling.
3. Desktop runtime smoke
   - Launch the exact built executable with an isolated data directory.
   - Verify its executable path and liveness.
   - Stop only that process, verify exit, and remove only the isolated data.
4. `git diff --check`
   - No whitespace errors.

These checks do not substitute for real-provider acceptance testing. No external
mailbox credentials are introduced into the repository verification suite.

## Completion evidence - 2026-08-16

The interrupted handoff was completed against the current worktree rather than
the earlier clean-branch snapshot:

- `cargo fmt` repaired the unfinished worker formatting pass.
- Clippy's `large_enum_variant` and `result_large_err` failures were fixed with
  indirection for the prepared-send step and failure context; no lint allowance
  was added.
- `npm run verify` exited successfully with 96 frontend tests and 228 Rust tests.
- `npm run tauri -- build --debug --no-bundle` produced
  `src-tauri/target/debug/easyemailam.exe` successfully. The final artifact was
  25,952,256 bytes, written at `2026-08-16 02:25:00 +08:00`, SHA-256
  `E9FA640A5A1C9988E85278DC136531FDD974580FBABF85517872961CD5E74878`.
- The exact debug executable stayed alive for 8 seconds as PID `33812` with the
  isolated directory `easyemailam-smoke-1786818318416`, created a non-empty
  4,096-byte SQLite database, and was stopped by its exact process ID.
- The isolated SQLite, WAL, SHM, and temporary directory were removed after the
  process exit was confirmed (`SMOKE_PROCESS_STOPPED=True`,
  `SMOKE_DATA_DIR_REMOVED=True`).

Real-provider IMAP, SMTP, and EasyEmail acceptance remains intentionally outside
this credential-free completion gate.

## Remaining optimization roadmap

### P1 - next reliability work

- [ ] **Define post-delivery reconciliation.** SMTP can succeed while a later
  local terminal compare-and-set loses ownership. Retrying blindly can duplicate
  mail, so this needs an idempotency/provider-message strategy and an explicit
  reconciliation state.
- [ ] **Implement real IMAP cursors.** The native fetch path currently ignores
  its cursor and requests only a recent bounded window. Persist UID validity and
  high-water marks, handle resets, and test incremental synchronization.
- [ ] **Measure and reduce database lock scope.** The desktop state owns a shared
  SQLite connection behind a mutex. Network work has been separated from many
  critical sections, but remaining contention should be profiled before moving
  to a connection pool or per-operation connections.
- [ ] **Continue frontend decomposition.** `src/App.tsx` still owns too many
  workflows. Extract view controllers/hooks by mailbox, compose, account setup,
  and agent mail while keeping selectors and command clients independently
  testable.

### P2 - product completeness and validation

- [ ] Add HTML/MIME and attachment sending with explicit size and content rules.
- [ ] Add component tests and browser-driven desktop workflow coverage; the
  current UI contract script is useful but intentionally source-structure aware.
- [ ] Add opt-in real IMAP/SMTP/EasyEmail acceptance tests using ephemeral test
  accounts and redacted artifacts.
- [ ] Plan a migration before changing the Tauri identifier ending in `.app`,
  because application identity and local data paths must remain compatible.
- [ ] Benchmark large local mailboxes and add query-plan/index regression checks.

## Completion rule

This optimization round is complete when the full verification gate, current
debug desktop build, isolated runtime smoke, diff hygiene check, and scoped Git
audit all pass. The unchecked roadmap items are deliberate follow-up work, not
claims that the product has no remaining engineering debt.
