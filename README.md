# EasyEmail

EasyEmail is the public monorepo entrypoint for the EasyEmail ecosystem.

It contains:

- `service/base`: the standalone EasyEmail Local Server and shared product core
- `clients/typescript`: an optional compatibility helper for the HTTP API
- `runtimes/userscript`: an independent browser-side provider runtime
- `upstreams/cloudflare_temp_email`: the upstream integration boundary for the Cloudflare temp mail worker
- `deploy`: deployment templates and operational scripts
- `docs`: repository-level architecture, quickstart, and upstream sync guidance

This repository intentionally avoids submodules. External contributors only need
to fork one repository and open pull requests here.

## Development Workflow

See `docs/development-workflow.md` for the shared cross-repository development
rules used for local-first iteration, temporary test assets, and final
GHCR-based validation.

## Toolchain

- Node.js `20.19+` is the minimum supported version across the repo.
- Enable Corepack before working with the `pnpm`-based upstream packages.
- The repository root includes `.nvmrc` and `.node-version` to pin the shared
  baseline.

## Repository Layout

```text
service/
  base/
clients/
  typescript/
runtimes/
  userscript/
upstreams/
  cloudflare_temp_email/
deploy/
  service/
    base/
  upstreams/
    cloudflare_temp_email/
docs/
scripts/
```

## Product Forms

EasyEmail has three distinct product forms:

1. **Standalone Local Server.** `service/base` can run on the caller's machine,
   another LAN machine, or a reachable remote machine. Programs call its
   documented HTTP API directly; no published SDK is required.
2. **Bundled UI.** The approved UI architecture packages the same `service/base`
   core with a UI host. Launching the UI automatically starts the packaged core,
   and the UI communicates with it over authenticated loopback HTTP. This
   lifecycle contract is defined, but a runnable UI package is not yet shipped.
3. **Userscript.** The Userscript is a completely independent browser runtime.
   It directly implements access to the configured upstream providers and never
   proxies through `service/base`.

The machine-readable boundary is [`product-contract.json`](product-contract.json).
See [`docs/architecture.md`](docs/architecture.md) for the full ownership model.

## Module Roles

### `service/base`

The standalone Local Server and the core bundled by the future UI. It owns:

- provider catalog and provider defaults
- HTTP API surface
- mailbox routing and strategy logic
- persistence and maintenance loops

Its public integration boundary is HTTP. See
[`docs/http-api.md`](docs/http-api.md) and the authoritative
[`docs/easyemail-openapi.json`](docs/easyemail-openapi.json).

### `runtimes/userscript`

The browser-side userscript runtime. It directly calls the configured providers
and is not a thin bridge that requires `service/base` to be online. It shares no
provider or mailbox business implementation with the server; only provider
names and externally defined upstream endpoints or ports may align.

### `clients/typescript`

An optional, independently packaged TypeScript/JavaScript compatibility helper
for the HTTP API exposed by `service/base`. It accepts the server URL and API key
at runtime and ships no operator credentials or deployment configuration. New
integrations may call the documented HTTP API directly; this package is not the
authoritative API contract.

### `upstreams/cloudflare_temp_email`

The upstream sync boundary for the Cloudflare temp mail worker and related
frontend. This code lives in the monorepo for contributor simplicity, but it is
still maintained as a distinct upstream-tracked area.

## Quick Start

### Local service runtime

The repository root now includes a host-facing one-click deploy wrapper:

```powershell
pwsh .\deploy-host.ps1
```

You can also download only `deploy-host.ps1` from GitHub and run it on a blank
host. The script bootstraps a local repo cache automatically before invoking
the canonical deployment path.

The same root entrypoint also supports owner-only runtime bootstrap through
either:

- `-ImportCode <decrypted-import-code>`
- `-BootstrapFile <r2-bootstrap.json>`

If you keep the owner private key as a stable passphrase string instead of a
raw base64 private key, derive the matching public key with:

```powershell
python .\scripts\easyemail-import-code.py derive-public-key --private-key-file .\owner-private-key.txt
```

That wrapper forwards into `scripts/deploy-service-base.ps1` and keeps the
stable in-network alias contract:

- `EasyAiMi`
- `easy-email-service`

If you need the lower-level entrypoint directly, it is still available:

```powershell
pwsh .\scripts\deploy-service-base.ps1
```

And if you only want the package-level service runtime checks:

```powershell
Set-Location service/base
npm install
npm run typecheck
npm run test
npm run build
```

### Browser userscript runtime

Read `runtimes/userscript/README.md` and generate a local userscript directly
from the root `config.yaml`. That file is the single source of operator
secrets for userscript generation.

The generated Userscript directly implements provider access in the browser. It
does not connect to the Local Server API.

### Direct HTTP integration

After starting `service/base`, any program can call it without installing an
EasyEmail client package. For example:

```powershell
$headers = @{ Authorization = "Bearer $env:EASY_EMAIL_API_KEY" }
Invoke-RestMethod `
  -Uri "http://127.0.0.1:18081/mail/catalog" `
  -Headers $headers
```

See [`docs/http-api.md`](docs/http-api.md) for mailbox creation examples in
PowerShell, curl, JavaScript, and Python.

### Bundled UI status

The UI lifecycle and packaging requirements are defined in
[`docs/ui-bundled-runtime.md`](docs/ui-bundled-runtime.md). The repository does
not yet claim a runnable or released UI package.

### Optional TypeScript HTTP helper

```powershell
Set-Location clients/typescript
npm ci
npm test
npm run pack:check
```

See `docs/client-userscript-distribution.md` for the API usage example, release
artifact contract, and the distinction between public and locally configured
Userscript outputs.

### Cloudflare temp mail upstream runtime

```powershell
Set-Location upstreams/cloudflare_temp_email/worker
corepack pnpm install
corepack pnpm lint
corepack pnpm build
```

## Documentation

- `docs/architecture.md`
- `docs/quickstart.md`
- `docs/http-api.md`
- `docs/easyemail-openapi.json`
- `docs/ui-bundled-runtime.md`
- `docs/upstream-sync.md`
- `docs/configuration.md`
- `docs/build-userscript.md`
- `docs/build-service-base-image.md`
- `docs/quick-deploy-cloudflare-mail.md`
- `docs/easyemail-release-workflow.md`
- `docs/release-tagging.md`
- `docs/github-actions-secrets.md`
- `docs/cloudflare-email-deployment.md`
- `docs/client-userscript-distribution.md`
- `docs/github-actions-client-distribution-plan.md`
- `docs/root-host-deploy-standard.md`
- `docs/publish-control-center-release-catalog.md`
- `CONTRIBUTING.md`

GitHub Actions release automation lives under `.github/workflows/`:

- `publish-service-base-ghcr.yml`
- `deploy-cloudflare-email.yml`
- `publish-client-userscript.yml`
- `release-easyemail.yml` (public-tag and selectable coordinated entrypoint)
- `validate.yml` (thin trigger wrapper)
- `reusable-validate.yml` (shared validation implementation)

## Operator Scripts

- `deploy-host.ps1`
- `scripts/init-config.ps1`
- `scripts/render-derived-configs.ps1`
- `scripts/compile-userscript.ps1`
- `scripts/validate-userscript.ps1`
- `scripts/compile-service-base-image.ps1`
- `scripts/deploy-service-base.ps1`
- `scripts/deploy-cloudflare-email.ps1`
- `scripts/deploy-easyemail-release.ps1`
- `scripts/quick-deploy-cloudflare-mail.ps1`
- `scripts/publish-control-center-release-catalog.ps1`
- `scripts/materialize-action-config.py`
- `scripts/validate-release-tag.py`
- `scripts/build-userscript-release.py`
- `scripts/build-distribution.py`

Hosted release sequencing, GitHub environments, evidence, retry, and rollback
boundaries are documented in `docs/release-operations.md`.

## Shared Config

Copy `config.example.yaml` to `config.yaml` before running the operator scripts.
The `config.yaml` file is ignored by Git and is used as the single source of
operator secrets for the scripts above.

For repository validation, `scripts/validate-userscript.ps1` uses
`config.example.yaml` by default and writes its generated output under `.tmp/`
so it does not touch your local userscript file.

For `service/base`, `scripts/render-derived-configs.ps1` renders
`deploy/service/base/config/config.yaml` from the root config and the internal
service template. For Cloudflare mail deployment, the same render step creates a
temporary worker `wrangler` config under `.tmp/`.

The main root sections are:

- `userscript`
- `serviceBase.runtime`
- `cloudflareMail.worker`
- `cloudflareMail.routing.plan`
- `publishing.ghcr`
- `publishing.controlCenter`

For Cloudflare temp mail deployment specifically, put deployment secrets in the
root `config.yaml` file under the `cloudflareMail` section. The direct deploy
entrypoint `scripts/deploy-cloudflare-email.ps1` reads that section and passes
it into the Cloudflare frontend build, worker deploy, and optional Email
Routing sync flow. The routing host list lives in
`cloudflareMail.routing.plan`; the script turns that into a temporary TOML plan
file during deployment.

For outbound sender-matrix testing, the same `cloudflareMail` section now also
supports:

- `cloudflareMail.worker.vars.RESEND_TOKEN`
- `cloudflareMail.sending.domains`
- `cloudflareMail.sending.preferredSenderDomain`
- `cloudflareMail.sending.preferredSenderLocalPart`

With those configured, deploy bootstrap will automatically provision or reuse
the Resend sending domain, upsert the required DNS records in Cloudflare, and
let EasyEmail reuse a stable sender mailbox such as
`matrixsender@tx-mail.example.com`.

## Security Notes

- Do not commit local deployment config, state, or generated userscript files.
- Do not commit live API tokens, auth headers, or database identifiers.
- Internal templates may stay in the repository, but user-edited runtime values
  must live only in the root `config.yaml`.

## Release Contract

This repository follows the EasyAiMi release contract v1 for the standalone
server, Cloudflare email center, optional compatibility client, independent
Userscript distribution, and blank-host local deployment. The bundled UI is an
approved product contract but is not yet a release surface. See
[docs/release-contract.md](docs/release-contract.md) for the exact current
release surfaces and security boundaries.
