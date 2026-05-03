# EasyEmail

EasyEmail is the public monorepo entrypoint for the EasyEmail ecosystem.

It contains:

- `service/base`: the local EasyEmail service runtime
- `runtimes/userscript`: the browser-side userscript runtime
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

## Module Roles

### `service/base`

The local service runtime. This is the main EasyEmail control plane that owns:

- provider catalog and provider defaults
- HTTP API surface
- mailbox routing and strategy logic
- persistence and maintenance loops

### `runtimes/userscript`

The browser-side userscript runtime. It is an independent runtime, not a thin
bridge that requires `service/base` to be online.

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
- `docs/upstream-sync.md`
- `docs/configuration.md`
- `docs/build-userscript.md`
- `docs/build-service-base-image.md`
- `docs/quick-deploy-cloudflare-mail.md`
- `docs/easyemail-release-workflow.md`
- `docs/release-tagging.md`
- `docs/github-actions-secrets.md`
- `docs/cloudflare-email-deployment.md`
- `docs/root-host-deploy-standard.md`
- `docs/publish-control-center-release-catalog.md`
- `CONTRIBUTING.md`

GitHub Actions release automation lives under `.github/workflows/`:

- `publish-service-base-ghcr.yml`
- `deploy-cloudflare-email.yml`

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
