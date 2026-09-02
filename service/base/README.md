# EasyEmail / service/base

`service/base` is the main local EasyEmail service runtime inside the public
EasyEmail monorepo.

It exposes the local HTTP API, aggregates mailbox providers, manages routing and
strategy decisions, and persists runtime state for the local service.

## Responsibilities

- provider catalog and runtime templates
- mailbox plan / open / observe / read-code flows
- strategy mode, provider pinning, cooldowns, and failure backoff
- provider health probing and maintenance
- runtime state persistence

## Runtime Contract

The runtime uses a file-driven contract:

- config path: `/etc/easy-email/config.yaml`
- state dir: `/var/lib/easy-email`

The top-level `config.yaml` sections are:

- `server`
- `aliasEmail`
- `maintenance`
- `persistence`
- `strategy`
- `providers`

This runtime file is generated from the repository root `config.yaml` by
`scripts/render-derived-configs.ps1`; the deployment template in
`deploy/service/base/config.template.yaml` is an internal base template only.

Only the minimal container environment variables remain canonical:

- `EASY_EMAIL_CONFIG_PATH`
- `EASY_EMAIL_STATE_DIR`
- `EASY_EMAIL_RESET_STORE_ON_BOOT`

### Bundled desktop credential resolution

The Tauri desktop package starts this same runtime as an exact private child. It
also provides two child-only environment variables:

- `EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER_URL`
- `EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER_TOKEN`

They must be configured together. The URL is restricted to an authenticated
`127.0.0.1` endpoint. The resolver submits account/ref metadata only; the Tauri
broker verifies exact ownership through the canonical account API before reading
Windows Credential Manager. The production IMAP connection test uses the pinned
ImapFlow dependency with TLS/STARTTLS and protocol logging disabled.

These variables are a bundled-desktop host contract, not a general standalone
secret format. Standalone deployments must inject an explicit server-side
`MailCredentialResolver`; without one, account IMAP tests fail closed with 503.

## Provider Naming

The formal provider key is:

- `cloudflare_temp_email`

Legacy names are not treated as canonical names anymore.

## Repository Structure

- `src/domain`: domain models, registry, OTP, and strategy logic
- `src/defaults`: provider types, instances, runtime templates, and strategy profiles
- `src/providers`: provider adapters including `cloudflare_temp_email`
- `src/service`: service orchestration
- `src/http`: contracts, routes, handlers, and server wiring
- `src/persistence`: file, sqlite, and database-backed state storage
- `src/runtime`: bootstrap and maintenance loops
- `src/shared`: local shared helpers

Key entrypoints:

- `src/index.ts`
- `src/runtime/main.ts`
- `index.ts`

## Deployment Assets

Deployment assets for this module live at:

- `deploy/service/base`

Key files there include:

- `Dockerfile`
- `docker-compose.yaml`
- `config.template.yaml` (internal base template used by the root render script)
- `docker-entrypoint.sh`
- `publish-ghcr-easy-email-service.ps1`
- `smoke-easy-email-docker-api.ps1`

## Local Validation

From the repository root:

```powershell
Set-Location service/base
npm install
npm run typecheck
npm run test
npm run build
```
