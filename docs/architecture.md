# Architecture

## Goal

This repository is the public monorepo for EasyEmail. It keeps contribution and
release automation in one repository while preserving explicit runtime and
product boundaries.

The machine-readable source of truth is
[`product-contract.json`](../product-contract.json).

## Product model

EasyEmail has one main server implementation, two forms that use that main
implementation, and one deliberately independent browser implementation.

```text
Any HTTP caller -----------+
                           | HTTP
                           v
                  +------------------+
                  |   service/base   |
                  | EasyEmail core   |
                  +------------------+

Bundled UI host -- starts the packaged service/base core
       |           and owns its process lifecycle
       +---------- authenticated loopback HTTP ----------^

Userscript -------- direct provider requests --------> upstream providers
     (no service/base dependency and no shared business implementation)
```

### Standalone Local Server

`service/base` can be deployed independently on the caller's machine, another
machine on the LAN, or a reachable remote machine. Any program may call it with
ordinary HTTP requests. A published EasyEmail SDK is not required.

The authoritative public interface is:

- human guidance: [`http-api.md`](./http-api.md)
- machine contract: [`easyemail-openapi.json`](./easyemail-openapi.json)

### Bundled UI

The bundled UI product packages the same `service/base` core with a UI host.
Launching the UI automatically starts the packaged core; the UI then calls it
over authenticated loopback HTTP. The user does not install a separate server,
Docker, or an external Node.js runtime.

The UI host owns startup, readiness, shutdown, crash reporting, port selection,
and secure token delivery. The UI does not own provider adapters or mailbox
business logic. The complete lifecycle and packaging requirements are in
[`ui-bundled-runtime.md`](./ui-bundled-runtime.md).

This architecture is approved, but no runnable UI artifact is currently
claimed. Desktop host and packaging technology remain an explicit implementation
decision.

### Independent Userscript

`runtimes/userscript` is a separate browser-side EasyEmail runtime. It directly
implements provider access, mailbox operations, and OTP reading in the browser.

It does not:

- call the `service/base` HTTP API;
- require the Local Server to be online;
- provide the provider layer for the bundled UI; or
- share provider adapters, mailbox orchestration, persistence, message
  processing, or lifecycle code with `service/base`.

The Userscript and server may align only on provider names and externally
defined upstream endpoints or ports. They remain parallel delivery targets.

## Core ownership

### `service/base`

The main EasyEmail service runtime owns:

- the authenticated HTTP API;
- provider catalog, adapters, credentials, and health;
- mailbox planning, routing, opening, sending, release, and recovery;
- message observation, verification-code extraction, and authentication-link
  extraction;
- persistence and recovery; and
- maintenance workers.

The same core is used in the standalone and future bundled-UI forms. UI code
must not duplicate these responsibilities.

### `clients/typescript`

This package is an optional compatibility helper for `service/base` HTTP calls.
It is not required for integrations, does not own the API contract, does not
contain the server, and does not manage a server process. New programs may call
the OpenAPI-described HTTP interface directly.

### `runtimes/userscript`

This directory owns the independent userscript template, provider runtime,
local configuration compiler flow, and public secret-free userscript artifact.
Its independence is intentional rather than a transitional client design.

### `upstreams/cloudflare_temp_email`

This directory is the upstream-tracked Cloudflare temp mail Worker and frontend.
It is an independently deployable provider and email center. Both the server and
the Userscript may connect to a deployed instance through their separate
implementations.

Keeping it in the monorepo:

- preserves a clean boundary for upstream synchronization;
- keeps public source visible to contributors; and
- avoids forcing contributors to coordinate multiple repositories.

## Dependency rules

Allowed:

- any external program -> documented `service/base` HTTP API;
- bundled UI -> packaged `service/base` through loopback HTTP;
- `service/base` provider adapters -> upstream provider APIs;
- Userscript provider runtime -> upstream provider APIs; and
- optional compatibility client -> documented `service/base` HTTP API.

Forbidden:

- requiring standalone callers to install an EasyEmail SDK;
- making the Userscript proxy through `service/base`;
- importing Userscript provider logic into the bundled UI;
- reimplementing server provider or mailbox logic in the UI;
- requiring a separate Local Server installation for the bundled UI; and
- requiring Docker or an external Node.js installation to launch the bundled
  UI product.

## Deployment and release boundaries

Current release surfaces are:

- `service/base` Local Server image and deployment/bootstrap assets;
- `upstreams/cloudflare_temp_email` Cloudflare email center;
- the independent secret-free Userscript; and
- the optional TypeScript compatibility package retained in the existing
  Client/Userscript distribution.

The bundled UI is not yet a release surface. It must receive its own component,
artifact contract, lifecycle tests, and clean-machine runtime evidence before it
is added to the coordinated workflow.

Deployment assets currently live under:

- `deploy/service/base`: standalone Local Server deployment assets;
- `deploy/upstreams/cloudflare_temp_email`: Cloudflare provider deployment
  assets.

## Why there are no submodules

Submodules make the external contribution flow harder: contributors must
discover multiple repositories, pull requests have ambiguous destinations, and
cross-module changes are difficult to review. The monorepo keeps one public
contribution surface without erasing runtime ownership boundaries.
