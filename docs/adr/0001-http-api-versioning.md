# ADR 0001: Preserve `/mail/*` As The Version 1 HTTP Surface

- Status: Accepted
- Date: 2026-09-01
- Milestone: M0

## Context

`service/base` already exposes a documented HTTP API under `/mail/*`. The route
constants live in `service/base/src/http/contracts.ts`, the OpenAPI document is
`docs/easyemail-openapi.json`, and standalone callers may already depend on
these paths. The desktop migration will add account, message, IMAP, SMTP,
taxonomy, contact, newsletter, Agent, avatar, and diagnostic resources.

Adding a second `/api/v1/mail/*` alias now would double the dispatch and test
surface without changing the protocol semantics. Replacing `/mail/*` would be a
breaking change with no migration benefit.

## Decision

1. The existing `/mail/*` surface is the canonical version 1 path space.
2. `docs/easyemail-openapi.json` is the authoritative public contract. Its
   semantic version records API compatibility:
   - patch: documentation or behavior clarification with no contract change;
   - minor: backward-compatible operations, fields, or enum values;
   - major: a breaking request, response, path, authentication, or error change.
3. New desktop-owned business capabilities use explicit `/mail/*` resources.
   They must not use a generic command/RPC endpoint.
4. Additive response fields must be optional to old callers unless the
   operation itself is new. Existing required fields and error codes remain
   stable within version 1.
5. Every write operation that can be retried must define its idempotency and
   concurrent-update behavior before implementation.
6. A future breaking version may introduce a new path prefix such as `/v2`, but
   only together with an explicit compatibility window, migration guide, and
   removal date. A version prefix is not added speculatively.
7. Route constants, dispatch, HTTP tests, OpenAPI paths, and the desktop command
   migration map must change atomically.

## Rejected Alternatives

### Make `/api/v1/mail/*` canonical immediately

Rejected because it creates duplicate routing and documentation while the
current API is already explicitly versioned as `1.0.0` in OpenAPI. It can be
reconsidered only for a real breaking version.

### Replace `/mail/*` without aliases

Rejected because it breaks standalone callers, the TypeScript compatibility
client, the users of the published documentation, and the existing desktop
transport.

### Expose `POST /commands/{name}`

Rejected because it reproduces the transitional Tauri RPC surface, prevents
resource-level documentation, and makes independent HTTP callers second-class.

## Migration And Rollback

- M0 freezes the current route/OpenAPI set with deterministic contract tests.
- Each later milestone adds explicit version 1 resources and updates OpenAPI in
  the same change as the route implementation.
- If a new operation fails acceptance, remove only that new operation and
  restore the previous OpenAPI document. Existing `/mail/*` behavior remains
  unchanged.
- Existing paths are never removed as part of a feature slice.

## Acceptance

- Every route constant and dynamic route template is unique and documented.
- Every static route constant is dispatched exactly once.
- OpenAPI methods match route implementations.
- Operation IDs are unique and all local schema references resolve.
- No route or OpenAPI path contains a generic `/commands` resource.
- The version 1 compatibility tests pass before and after every feature slice.

