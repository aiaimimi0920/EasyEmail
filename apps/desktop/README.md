# EasyEmail Desktop (imported from EasyEmailAM)

> Migration status: this source is now managed at `apps/desktop` in the
> EasyEmail monorepo. The imported application still uses its original Tauri
> command/Rust backend while business ownership is moved to `service/base` HTTP
> APIs. It is buildable migration input, not yet an approved bundled EasyEmail
> desktop release. See
> [`../../docs/easyemailam-migration.md`](../../docs/easyemailam-migration.md).

EasyEmailAM is a Windows-first desktop mailbox aggregation client built with
Tauri 2, Rust, React 19, TypeScript, and SQLite. It brings conventional IMAP
mailboxes, temporary EasyEmail mailboxes, verification-code workflows, and
agent-oriented mail into one local desktop application.

## Current capabilities

- Connect normal mail accounts through IMAP and send mail through SMTP.
- Create, refresh, and promote temporary EasyEmail mailboxes.
- Aggregate anonymous and account mail into a local SQLite-backed view.
- Detect recent verification codes and poll a waiting mailbox for a new code.
- Browse mail by folders, labels, newsletters, threads, and local state.
- Compose drafts, schedule delivery, and process sends through a durable queue.
- Create agent accounts, services, tasks, replies, and thread views.
- Resolve sender avatars from contacts, DNS authentication records, and guarded
  HTTPS sources.
- Store mailbox passwords in the operating-system credential vault rather than
  in SQLite.

## Architecture

- `src/`: React UI, Tauri command clients, mail selectors, compose utilities,
  and reusable components.
- `src-tauri/src/commands.rs`: desktop command boundary and DTO mapping.
- `src-tauri/src/services/`: application use cases and transaction boundaries.
- `src-tauri/src/storage/`: SQLite migrations and repositories.
- `src-tauri/src/imap/` and `src-tauri/src/smtp/`: native mail transports.
- `src-tauri/src/workers/`: durable send-queue processing.
- `tests/`: frontend unit tests; Rust unit and repository tests live beside the
  implementation modules.
- `scripts/`: UI contract checks and production-preview smoke tests.

The backend keeps secrets behind credential references, redacts provider
snapshots and diagnostics, rejects plaintext mail authentication, and validates
and pins network destinations used by remote avatar lookup.

## Development

Prerequisites are Node.js/npm, the Rust toolchain, and the platform requirements
for Tauri 2. On Windows, WebView2 is also required.

```powershell
npm ci
npm run tauri -- dev
```

Run the complete repository gate before handing off a change:

```powershell
npm run verify
```

The gate runs frontend unit tests, the UI contract verifier, TypeScript and Vite
production builds, an HTTP preview smoke test, Rust formatting, Clippy with
warnings denied, Rust tests, and `cargo check`.

Build the desktop application with:

```powershell
npm run tauri -- build
```

For a faster compile-oriented desktop check without packaging installers:

```powershell
npm run tauri -- build --debug --no-bundle
```

## Product and engineering references

- [Design rules](docs/design/easyemailam-design-rules.md)
- [Original product specification](docs/superpowers/specs/2026-06-11-easyemailam-design.md)
- [Tracked implementation phases](docs/progress/MASTER.md)
- [2026-08-15 code review and optimization plan](docs/reviews/2026-08-15-code-review-and-optimization.md)

The minimum supported content resolution and default desktop window size are
both `1024x768`. Larger windows may use responsive layouts, but new UI work must
continue to support that baseline.
