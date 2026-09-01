# Desktop Command To HTTP Migration Map

Status: **M0 baseline accepted; feature migration not complete**.

The machine-readable source is
[`desktop-command-http-migration-map.json`](./desktop-command-http-migration-map.json).
It is checked against the Tauri `generate_handler!` registration by repository
contract tests.

## Baseline

- Repository baseline: `97dd334fbcd2f95330a8e19a23b366af54671220`
- Registration source: `apps/desktop/src-tauri/src/lib.rs`
- Registered commands: 56
- Retained host/OS commands: 2
- Business commands migrating to explicit HTTP resources: 52
- Unsigned platform-development commands to remove: 2

The retained host commands are `health_check` and `desktop_core_runtime`.
Retention means that they remain Tauri host operations; it does not authorize
mail business logic in the host.

`platform_account_get_session` and `platform_account_query_data` are development
stubs. They must be removed in M7C or replaced by a separately designed real
external-account API. They must not become production identity.

## Capability Groups

| Capability | Current implementation | Final milestone/owner |
| --- | --- | --- |
| Temporary mailbox | Rust EasyEmail/temp services and repository | M1/M7A, `service/base` |
| Settings and low-risk CRUD | Rust settings/contact/taxonomy/newsletter repositories | M2, `service/base` |
| Normal accounts and credentials | Rust account service, native IMAP, Windows vault | M3/M6, `service/base` plus Tauri OS-vault broker |
| Messages and verification | Rust message/verification repositories and services | M4, `service/base` |
| SMTP send queue | Rust SMTP adapter, queue repository, worker | M5, `service/base` |
| Agent mail | Rust Agent service/repository | M7B, `service/base` |
| Avatar | Rust resolver/cache and Tauri commands | M7C, `service/base` |
| Host lifecycle | Tauri core runtime | M9, retained Tauri host boundary |

## Update Rule

The JSON mapping and its contract test must change in the same commit whenever:

- a Tauri command is added, renamed, removed, or registered;
- a target HTTP method/path is changed before implementation;
- a capability crosses its milestone exit gate; or
- a command changes from `migrate_http` to removed.

A target path in this M0 map is a migration contract, not evidence that the
route already exists. OpenAPI and runtime implementation are added by the
assigned milestone. A command is not considered migrated until the UI uses the
packaged core through HTTP and the corresponding persistence/runtime tests pass.

## Related Decisions

- [`ADR 0001`](./adr/0001-http-api-versioning.md): version 1 keeps `/mail/*`.
- [`ADR 0002`](./adr/0002-core-persistence-and-migrations.md): repositories and migrations.
- [`ADR 0003`](./adr/0003-desktop-credential-broker.md): opaque credential references.
- [`ADR 0004`](./adr/0004-bundled-core-graceful-shutdown.md): private shutdown control channel.

