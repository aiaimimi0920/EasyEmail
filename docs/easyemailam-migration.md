# EasyEmailAM Desktop Migration

Status: **source imported; business ownership migration in progress**.

This document records the controlled migration of the EasyEmailAM desktop
application into [`apps/desktop`](../apps/desktop). It is both an implementation
plan and a guard against accidentally shipping two competing EasyEmail cores.

## Source and preservation boundary

The imported baseline came from the EasyEmailAM `foundation` branch at commit
`34838bc`. The source worktree contained reviewed but uncommitted changes, so the
import intentionally captured the current files rather than reconstructing only
the last commit.

The sibling EasyEmailAM repository remains untouched and is the rollback source.
It must not be deleted until the migrated desktop package has passed the release
acceptance gates in [`ui-bundled-runtime.md`](./ui-bundled-runtime.md).

The import excludes generated or machine-local state: `.git`, `node_modules`,
`dist`, `src-tauri/target`, `.easyemailam`, Graphify output, local logs, and
root-level visual test captures. The exact 182-file import is recorded by:

- [`SOURCE_SNAPSHOT.json`](../apps/desktop/SOURCE_SNAPSHOT.json)
- [`SOURCE_SNAPSHOT_FILES.sha256`](../apps/desktop/SOURCE_SNAPSHOT_FILES.sha256)

The snapshot hashes describe the original imported baseline. They are not
updated as the destination is migrated.

## Required final ownership

The final product has one business core:

```text
apps/desktop React UI
        |
        | authenticated loopback HTTP
        v
service/base
        |
        +-- temporary providers and mailbox orchestration
        +-- normal IMAP accounts and synchronization
        +-- SMTP send queue and retry state
        +-- aggregated messages, folders, labels, contacts, and newsletters
        +-- verification-code classification and polling
        +-- temporary-mailbox promotion
        +-- Agent mail tasks and reply association
        +-- avatar resolution/cache and redacted diagnostics
```

The Tauri host may own only operating-system and packaged-process concerns:

- single-instance behavior;
- selection of a loopback port;
- generation and protected delivery of the local API token;
- startup, readiness, monitoring, and shutdown of the packaged core;
- application-data path selection;
- operating-system credential-vault access where raw secrets must never cross an
  untrusted webview boundary;
- native window, notification, opener, and installer integration.

The Tauri host must not remain the owner of IMAP/SMTP network behavior,
provider selection, message persistence, send retries, verification-code
classification, mailbox promotion, Agent reply association, or remote avatar
fetching.

## Imported transitional state

The imported application is buildable and preserves all EasyEmailAM features.
The Tauri host now starts the compiled `service/base` core with a private Node
runtime, waits for authenticated loopback readiness, and the React startup path
queries the canonical `/mail/catalog` resource. Most extended business features
are still owned by the transitional Rust backend, so this remains an explicitly
temporary, non-release state. In particular:

- `src/App.tsx` uses HTTP for bundled-core startup readiness but still calls the
  Tauri command surface for mailbox and extended client operations;
- `src-tauri/src/commands.rs` still maps UI requests to Rust services;
- the Rust services and SQLite repositories still implement the extended mail
  client behavior;
- normal close reaps the exact child process, but the core does not yet expose a
  graceful shutdown API;
- the manual desktop candidate workflow uploads only unsigned migration
  evidence; no desktop release is added to the coordinated release workflow.

Keeping this intermediate state buildable prevents feature loss while each
ownership boundary is moved and verified. It does not authorize a public desktop
release.

## Capability migration matrix

| Capability | Imported owner | Final owner | Migration rule |
| --- | --- | --- | --- |
| Temporary mailbox create/fetch | Rust EasyEmail adapter and services | Existing `service/base` HTTP API | Replace Tauri commands with canonical mailbox/session/message HTTP calls. Preserve full recovery and lifecycle fields rather than the old lossy DTO mapping. |
| Accounts and mailbox sources | Rust domain and SQLite repositories | `service/base` account domain and persistence | Add versioned contracts; keep normal, Agent, system, and anonymous scopes distinct. |
| IMAP synchronization and actions | Rust native IMAP adapter | `service/base` provider/service layer | Port connection security, cursor, deduplication, and action semantics with fake-adapter tests. |
| SMTP and durable send queue | Rust SMTP adapter, repository, worker | `service/base` service, worker, and HTTP routes | Preserve atomic claim, stale lease recovery, terminal compare-and-set, scheduling, and retry behavior. |
| Aggregated message views | Rust message repository | `service/base` message query API | Preserve source traceability; do not copy or move messages during promotion. |
| Verification codes | Rust verification service | `service/base` OTP/message service | Reuse existing EasyEmail freshness logic and add persisted recent-code queries. |
| Promotion | Rust temp mailbox service | `service/base` account/mailbox service | Promotion changes product visibility only; it never changes provider lifetime. |
| Agent mail | Rust agent service/repository | Optional `service/base` Agent module | Preserve account-scope isolation, trust checks, task threads, and reply association. |
| Taxonomy, contacts, newsletters | Rust SQLite repositories | `service/base` persistence and HTTP API | Add versioned resources and expose DTOs over HTTP. |
| Sender avatars | Rust DNS/HTTPS resolver and cache | `service/base` resolver/cache; UI consumes DTO | Preserve HTTPS/public-address/redirect/size protections. |
| Platform account preview | Rust development stub | Remove or replace with a real external account API | Never ship the unsigned development session as production identity. |
| Credential vault | Windows Credential Manager | Tauri OS bridge plus opaque `service/base` references | Never copy credential blobs or place plaintext secrets in SQLite, HTTP logs, or web storage. |

## API migration sequence

1. Introduce a typed desktop HTTP transport whose base URL and bearer token are
   injected by the trusted Tauri host.
2. Move the already-supported temporary-mailbox flows to the authoritative
   OpenAPI operations: catalog, plan/open, observed messages, verification code,
   authentication link, update, release, recovery, send, and outcome reporting.
3. Expand `service/base` with versioned account, message, IMAP, SMTP queue,
   taxonomy, contact, newsletter, Agent, avatar, and diagnostic resources.
4. Move one UI command group at a time from Tauri invocation to HTTP. Run the
   same frontend contract tests before and after every group.
5. Delete the corresponding Rust business module only after the HTTP path has
   equivalent behavior and persistence tests.
6. Reduce `src-tauri` to the trusted desktop host and OS integration layer.

Do not add one generic `POST /commands/{name}` escape hatch. Every migrated
capability needs an explicit HTTP resource, request/response contract, error
model, and OpenAPI entry so standalone callers receive the same capability.

## Persistence and credential migration

The imported EasyEmailAM database and the existing `service/base` state store
are different models and must not share a file. Migration requires an explicit,
versioned importer:

1. stop the desktop app and back up `easyemailam.sqlite`, `-wal`, and `-shm`;
2. validate the EasyEmailAM schema migration versions and row counts;
3. import non-secret records idempotently into the expanded core schema;
4. retain opaque credential references and verify that referenced OS-vault
   entries still exist;
5. require reauthentication for missing entries instead of copying credential
   material;
6. verify counts, source linkage, queue states, and a sample of message hashes;
7. on failure, discard the new imported state and restore the backup without
   changing the source database.

The Tauri identifier `com.easyemailam.app`, local data directory, database name,
and Windows Credential Manager target prefix must remain compatible until that
importer and rollback path are proven.

## Build and release phases

### Phase A - imported source baseline

- `npm ci`
- `npm run verify`
- no desktop artifact publication

### Phase B - HTTP-owned feature slices

- contract and OpenAPI tests for every new route;
- service/domain/persistence tests for every moved invariant;
- UI transport tests that assert exact HTTP method, path, headers, and payload;
- runtime proof that the UI reads and writes only through loopback HTTP.

### Phase C - packaged product

`service/base` is currently a Node.js program. The desktop artifact must package
a private self-contained core runtime, either as a Node single-executable
application or as a bundled private Node runtime plus compiled service assets.
Requiring a separately installed Node.js remains forbidden.

The current migration packages a private Node runtime, compiled `service/base`
assets, and the runtime `yaml` dependency under Tauri resources. The host owns a
single exact child, selects an ephemeral loopback port, generates a runtime-only
bearer token, waits for authenticated catalog readiness, and reaps the child on
normal UI exit. `build-desktop-candidate.yml` can build unsigned MSI/NSIS
candidates and upload a manifest plus SHA-256 checksums, but it deliberately does
not create a tag or GitHub Release.

The Windows GitHub Actions job must build the core, package the Tauri app,
produce MSI/NSIS artifacts, record source revisions and SHA-256 checksums, and
upload provenance. Publication remains blocked until clean-machine install,
automatic core startup, authenticated readiness, a real mailbox flow,
persistence restart, port collision, crash recovery, and isolated shutdown all
pass.

## Rollback

Before public cutover, rollback is simply using the preserved EasyEmailAM source
and its existing data directory. After cutover, rollback additionally requires
restoring the pre-import database trio and the previous desktop binary. No
source deletion, data contraction, identifier change, or credential cleanup is
part of this migration unless separately authorized after the new release is
proven.
