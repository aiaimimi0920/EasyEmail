# Architecture

## Goal

This repository is the public monorepo for EasyEmail. It replaces the older
multi-repository workspace entrypoint with a single contributor-facing
repository.

## Top-Level Areas

### `service/base`

The main EasyEmail service runtime.

Responsibilities:

- HTTP API
- provider orchestration
- mailbox routing strategies
- persistence and recovery
- maintenance workers

### `runtimes/userscript`

The browser-side EasyEmail runtime delivered as a userscript.

Responsibilities:

- open temporary mailboxes directly in the browser
- poll inboxes and read OTP codes
- keep a browser-local provider runtime

Important:

- this is not a required frontend for `service/base`
- this is not a hard dependency of `service/base`
- both runtimes are parallel delivery targets

### `upstreams/cloudflare_temp_email`

The upstream-tracked Cloudflare temp mail worker and frontend.

Responsibilities:

- preserve a clean boundary for upstream synchronization
- keep public source visible inside the monorepo
- avoid forcing contributors to work across multiple repositories

## Why There Are No Submodules

Submodules make external contribution flow harder:

- contributors must discover multiple repositories
- PR destination becomes ambiguous
- cross-module changes become difficult to review

This monorepo keeps all public contribution in one place while preserving
internal boundaries between modules.

## Deployment Assets

- `deploy/service/base`: deployment assets for the local service runtime
- `deploy/upstreams/cloudflare_temp_email`: deployment assets for the upstream worker

