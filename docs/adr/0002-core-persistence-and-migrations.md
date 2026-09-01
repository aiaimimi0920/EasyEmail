# ADR 0002: Expand Persistence Through Versioned Repository Contracts

- Status: Accepted
- Date: 2026-09-01
- Milestone: M0

## Context

`service/base` currently persists a provider/mailbox snapshot through the
`MailStateStore` and `MailStateQueryRepository` contracts. File, SQLite, and
database-backed adapters exist. The imported EasyEmailAM application has a
different relational SQLite model for accounts, credential references,
folders, messages, temporary mailboxes, send queue entries, contacts,
taxonomy, verification records, Agent state, and settings.

The two stores must not share a file or mutate each other's schema in place.
Snapshot-only persistence is also insufficient for atomic queue claims,
incremental IMAP synchronization, stable pagination, and concurrent updates.

## Decision

1. `service/base` owns the final persistence model for all mail business data.
2. Each capability is accessed through a narrow repository contract owned by
   the corresponding domain/service module. HTTP handlers and the desktop UI
   never read storage directly.
3. The desktop packaged runtime uses SQLite for relational capabilities. Schema
   changes use an ordered `schema_migrations` ledger and forward-only,
   transactional migrations.
4. Existing provider/mailbox snapshot persistence remains compatible while
   relational repositories are introduced. New code must not create a second
   copy of the same authoritative entity.
5. File and external-database adapters must either implement the same repository
   contract or report an explicit unsupported capability during runtime
   startup/catalog inspection. They must not silently fall back to ephemeral
   memory for data advertised as persistent.
6. Repository writes use stable IDs, transactions, unique constraints, and
   version/CAS semantics where stale writes are possible. Retryable operations
   define idempotency keys.
7. Message records permanently retain source/account/session/provider/external
   identifiers. Promotion, folder views, and Agent association do not copy or
   move the authoritative message.
8. Queue claim, lease recovery, and terminal transitions are persistence
   invariants, not worker/UI conventions.
9. The legacy EasyEmailAM database is imported only by the versioned M8
   importer. `service/base` never opens it for live dual-write or in-place
   migration.

## Rejected Alternatives

### Extend one global JSON snapshot indefinitely

Rejected because it cannot safely express concurrent queue leases, incremental
sync checkpoints, relational integrity, or efficient paginated message queries.

### Reuse `easyemailam.sqlite` directly

Rejected because it couples the new core to the old Rust schema, prevents an
idempotent importer, and makes rollback unsafe.

### Maintain long-term dual-write between Rust and `service/base`

Rejected because it creates two authorities and makes partial failures
unrecoverable. Migration uses one capability slice at a time and a final import.

## Migration And Rollback

- New tables and indexes are additive until the M8 import is proven.
- Before migrating a real user database, stop writes and back up the source
  SQLite, WAL, SHM, and target state.
- Migrations record version, checksum, start/finish time, and result.
- A failed migration rolls back its transaction. A failed import discards the
  new target state and restores the pre-import backup; it never mutates the
  source database.
- Destructive schema contraction is deferred until after a separately approved
  retention period and is not part of the desktop migration.

## Acceptance

- Repository contract tests run against every adapter that advertises support.
- Migrations are deterministic, transactional, checksum-verified, and
  idempotent on restart.
- Fixtures prove clean creation, old-version upgrade, interrupted migration,
  restart readback, and backup restoration.
- Concurrency tests prove queue claim/CAS and stale-lease recovery.
- Unsupported adapters fail closed with a documented capability result.
- M8 verifies row counts, source linkage, queue states, and sampled message
  hashes before the old Rust repositories are removed.

