# Bundled UI Runtime Contract

Status: **private core packaging and authenticated startup implemented; business
HTTP ownership, graceful shutdown, and release acceptance are not yet complete**.

This document defines the product boundary for a lightweight EasyEmail UI. The
desktop framework is now Tauri 2 with React 19, based on the imported EasyEmailAM
application. Importing a buildable application does not by itself satisfy the
release contract. The current host implements the initial packaged-core
lifecycle, while feature-by-feature ownership migration remains in progress.

The staged ownership migration is recorded in
[`easyemailam-migration.md`](./easyemailam-migration.md).

## Product definition

The bundled UI product contains:

1. the same `service/base` EasyEmail core used by the standalone Local Server;
2. a UI host that owns the core process lifecycle; and
3. UI assets that call the packaged core through the documented HTTP API.

Launching the UI must be sufficient to use the product. The user must not have
to install or start a separate EasyEmail server, Docker, or an external Node.js
runtime.

The UI is a product shell around the main core, not a second mail-server
implementation. Provider adapters, mailbox orchestration, message processing,
persistence, and maintenance remain owned by `service/base`.

## Required lifecycle

The UI host must perform this sequence:

1. Enforce the product's single-instance policy or connect to the already
   running instance.
2. Select an available loopback port without exposing the service on LAN
   interfaces.
3. Generate the runtime API token and a separate per-start credential-broker
   bearer token.
4. Start a private credential broker on an ephemeral `127.0.0.1` port. It may
   resolve only allowlisted, account-owned opaque references and must never expose
   its token or resolved values to the renderer.
5. Start the packaged `service/base` core with explicit configuration, state
   directory, loopback host, port, and API token.
   Pass the broker URL/token only to that exact child process.
6. Wait until an authenticated `GET /mail/catalog` request succeeds before
   enabling UI operations. The current core has no dedicated health route, so
   the catalog request is the readiness boundary.
7. Send every UI operation through the same HTTP API documented in
   [`http-api.md`](./http-api.md).
8. On normal UI exit, stop and reap only the child process created by this UI
   instance. The current core has no graceful shutdown endpoint, so the host
   terminates that exact child directly and waits for it to exit.
9. After a graceful shutdown endpoint is added, request it first and terminate
   the exact child only if that request times out. Never kill an unrelated
   standalone EasyEmail server.
10. Stop the credential broker after the child has exited; an unexpected child
    exit also invalidates the broker token and stops the listener.

The host must surface startup and runtime failures to the user. It must not
silently fall back to copying provider logic into the UI.

## Packaging requirements

A released UI package must:

- include a self-contained executable form of the `service/base` core;
- include the UI host and UI assets;
- run without Docker and without a separately installed Node.js runtime;
- record the exact source commit and core build identity in release metadata;
- keep writable state in the operating system's application-data directory,
  never in an installation directory that may be read-only;
- preserve persisted state across UI upgrades;
- avoid embedding operator credentials in static UI assets;
- verify package contents, checksums, and provenance before publication.

Whether the core is packaged as a sidecar executable or embedded into a native
host is an implementation choice. It must still be built from the same
`service/base` main implementation and expose the same HTTP contract.

## Loopback security contract

- Bind the packaged core to `127.0.0.1` or an equivalent loopback address only.
- Use a high-entropy token that is not present in source control or static web
  assets.
- Deliver the port and token to the UI through the host's trusted runtime
  boundary, not through a public URL parameter.
- Do not write the token to logs, crash reports, release manifests, or browser
  storage that arbitrary web origins can read.
- Reject navigation or requests from untrusted remote origins when the selected
  UI framework exposes a webview.
- Ensure a second local process cannot cause the UI to connect to a fake service
  merely by occupying the preferred port.
- Keep the credential-broker token separate from the core API token. It may exist
  only in the host and exact child process memory/environment and must never be
  returned by the Tauri runtime descriptor.

## Process and recovery behavior

The implementation must define and test:

- startup timeout and retry limits;
- unexpected core exit reporting;
- stale child-process detection after a UI crash;
- port-collision behavior;
- multiple UI launches;
- graceful close and forced-close escalation;
- persisted-state migration and rollback;
- core log location, rotation, and secret redaction;
- offline first startup when provider networks are unavailable.

Automatic restart may be added, but it must be bounded and visible. A crash loop
must not continuously respawn the core or hide the original failure.

## Current implementation evidence

The current Windows implementation:

- packages the current Node runtime, compiled `service/base` assets, and locked
  production dependencies including YAML and ImapFlow as private Tauri resources;
- starts exactly one child on an ephemeral `127.0.0.1` port with a generated
  bearer token and application-data persistence;
- waits for authenticated `GET /mail/catalog` readiness and makes the React
  startup path repeat that semantic HTTP request;
- rejects an unauthenticated catalog request and reaps the exact child when the
  UI closes normally;
- stores new IMAP passwords through a narrow Tauri OS-vault command and returns
  only versioned opaque refs;
- starts a separate authenticated credential broker, injects it only into the
  exact Node child, scope-checks each lookup through the canonical account API,
  and stops it with that child;
- installs the production ImapFlow connection tester in the packaged core;
- routes React normal-account list/create/test/disable/delete through the
  authenticated bundled HTTP client, while raw IMAP secrets use only the narrow
  Tauri vault bridge and account HTTP bodies contain opaque references;
- disables transitional normal-account message sync and SMTP entry points for
  canonical core accounts until M6/M5 rather than crossing the two databases;
- provides a manual, read-only-permission candidate Action that builds unsigned
  MSI/NSIS installers plus a non-release manifest and SHA-256 checksums.

This evidence does not yet prove graceful shutdown, a clean-machine installer,
restart credential resolution, collision/crash recovery, a controlled real IMAP
connection, or a real mailbox flow through the UI HTTP path. The React account
screen now uses the canonical HTTP account resources, but old-account import and
most other extended EasyEmailAM operations still use transitional Tauri commands.

## HTTP usage

The UI may use `fetch` or a private generated client inside the UI application.
It does not require the separately published `clients/typescript` package. The
OpenAPI document is the authoritative interface between UI and core.

The UI must not import server-internal modules or reach into persistence files.
Keeping the HTTP boundary intact ensures that standalone and bundled forms use
the same observable behavior.

## Userscript separation

The Userscript is not part of this bundle and is not the UI's provider layer.
It remains a completely independent browser-side implementation that directly
calls the configured upstream providers.

The two implementations may align only on provider names and externally defined
upstream endpoints or ports. They do not share provider adapters, mailbox
orchestration, persistence, message-processing logic, or process lifecycle code.

## Release acceptance gates

The UI must not be added to the coordinated release targets or described as
available until a candidate package passes all of these gates:

1. Build a self-contained package on every declared target operating system.
2. Install or unpack it on a clean machine without Docker or Node.js.
3. Launch the UI and prove that it starts the packaged core automatically.
4. Prove authenticated loopback readiness and one real mailbox-open flow through
   the UI-to-core HTTP boundary.
5. Close the UI and prove that its child core exits without affecting an
   independently started server.
6. Restart and prove persistence survives.
7. Exercise port collision, core crash, corrupt state, and upgrade/rollback
   behavior.
8. Verify exact artifacts, checksums, source revision, and provenance.

When these gates exist, the UI should receive its own release component and
artifact manifest. It must not be inserted into the existing Client/Userscript
manifest, whose exact artifact set is a separate compatibility contract.

## Non-goals

- Reimplementing `service/base` provider logic in the UI.
- Requiring callers of the standalone server to install the UI.
- Requiring a public SDK for UI-to-core calls.
- Converting the Userscript into a `service/base` client.
- Claiming a UI release based only on source compilation or a web preview.

## Selected desktop host

Tauri 2 is the selected desktop host and React 19 is the imported UI stack. The
current implementation uses the permitted bundled-private-Node option for the
TypeScript `service/base` core. It is not release-complete until the host and
installer satisfy every lifecycle, security, provenance, and clean-machine gate
above.

The imported Rust business services are transitional migration input. They must
be removed as their HTTP-owned equivalents become complete; they are not an
alternative permanent core.

EasyProxy is a useful structural reference for keeping frontend assets and
release automation organized around a local service. Its runtime and business
implementation are not an EasyEmail dependency and must not be copied as if the
projects were equivalent.
