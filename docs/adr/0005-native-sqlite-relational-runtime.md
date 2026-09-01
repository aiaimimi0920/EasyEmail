# ADR 0005: Use Native Node SQLite For New Relational Domains

- Status: Accepted
- Date: 2026-09-01
- Milestone: M2

## Context

ADR 0002 assigns final mail-business persistence to `service/base` and requires
the packaged desktop runtime to provide relational SQLite without reusing or
mutating the legacy EasyEmailAM database. The older provider/mailbox snapshot
SQLite adapter invokes a Python helper. That adapter remains valid for its
existing deployment modes, but the desktop core bundle contains only the
compiled service, runtime dependencies, configuration, and a Node executable.
It must not require a separately installed Python runtime.

## Decision

1. New relational domains use Node's built-in `node:sqlite` `DatabaseSync` API.
2. `service/base` and the packaged core require Node 22.13 or newer, which is the
   first Node 22 release where `node:sqlite` no longer requires an experimental
   command-line flag. The API remains release-candidate stability, so all SQL is
   isolated behind narrow repository contracts.
3. New relational data is stored in `easy-email-relational.sqlite3`, alongside
   but never inside the provider/mailbox snapshot file or database.
4. The legacy EasyEmailAM SQLite file remains read-only migration input until
   the separately gated M8 importer. There is no live dual-write.
5. Every schema step is ordered, checksummed, forward-only, and transactional.
   The migration ledger records version, name, checksum, start/finish time,
   result, and a non-sensitive error code.
6. Before applying a pending migration to an existing target database, the
   runtime creates a consistent SQLite `VACUUM INTO` backup. The explicit
   restore helper rejects open in-process targets, validates the backup, and
   atomically preserves the old database/WAL/SHM before replacement.
7. When relational persistence is disabled or unavailable, HTTP resources fail
   closed with `CONTACTS_PERSISTENCE_UNAVAILABLE`; they never fall back to an
   in-memory store outside tests.

## Initial Schema And Semantics

Schema version 1 owns contacts. Email address is the stable unique key. Create
preserves the legacy upsert behavior: an existing normalized address retains
its ID and creation time while display name, note, update time, and version are
updated. Lists use case-insensitive name/email ordering and opaque keyset
cursors. Update and delete require `expectedVersion`; deletion is hard and does
not affect messages. The legacy Rust contact repository remains untouched for
the M8 importer but is no longer the UI authority after the HTTP cutover.

Taxonomy and newsletter tables will be additive later in M2. Newsletter list
derivation is not fabricated before the M3/M4 account and aggregated-message
models exist; only durable subscription overrides belong in this database.

## Rollback

- Stop every process using the target before restoring a backup.
- The restore helper validates SQLite integrity and the migration ledger.
- The current target, WAL, and SHM are renamed and retained for diagnosis before
  the validated backup is atomically moved into place.
- Never restore over or mutate the legacy EasyEmailAM source database.

## Acceptance

- Clean creation, idempotent restart, newer-schema rejection, checksum mismatch,
  failed-transaction rollback, open-target refusal, backup restoration, CRUD,
  unique conflict, CAS conflict, ordering, pagination, and runtime restart
  readback are automated.
- The packaged core gate uses its bundled Node executable to create and list a
  contact through authenticated HTTP.
