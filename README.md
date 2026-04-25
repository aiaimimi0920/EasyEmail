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

```powershell
Set-Location service/base
npm install
npm run typecheck
npm run test
npm run build
```

### Browser userscript runtime

Read `runtimes/userscript/README.md` and generate a local userscript from the
template plus your private secrets file.

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
- `docs/cloudflare-email-deployment.md`
- `CONTRIBUTING.md`

## Operator Scripts

- `scripts/init-config.ps1`
- `scripts/compile-userscript.ps1`
- `scripts/compile-service-base-image.ps1`
- `scripts/deploy-cloudflare-email.ps1`
- `scripts/quick-deploy-cloudflare-mail.ps1`

## Shared Config

Copy `config.example.yaml` to `config.yaml` before running the operator scripts.
The `config.yaml` file is ignored by Git and is used as the single source of
operator secrets for the scripts above.

For Cloudflare temp mail deployment specifically, put deployment secrets in the
root `config.yaml` file under the `cloudflareMail` section. The direct deploy
entrypoint `scripts/deploy-cloudflare-email.ps1` reads that section and passes
it into the Cloudflare frontend build, worker deploy, and optional Email
Routing sync flow. The routing host list lives in
`cloudflareMail.routing.plan`; the script turns that into a temporary TOML plan
file during deployment.

## Security Notes

- Do not commit local deployment config, state, or generated userscript files.
- Do not commit live API tokens, auth headers, or database identifiers.
- The tracked `upstreams/cloudflare_temp_email/worker/wrangler.toml` is a public
  example config and must stay sanitized.
