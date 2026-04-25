# Quick Start

## 1. Clone The Repository

```powershell
git clone <your-repo-url> EasyEmail
Set-Location EasyEmail
```

## 2. Edit The Root Config Once

Copy `config.example.yaml` to `config.yaml` and edit only that file.

All service, userscript, and Cloudflare deployment settings are derived from it.

## 3. Prepare The Local Service Runtime

Render the service config from the root config and start the service:

```powershell
pwsh .\scripts\deploy-service-base.ps1
```

If you only want to render the generated config file without starting Docker:

```powershell
pwsh .\scripts\render-derived-configs.ps1 -ServiceBase
```

## 4. Work On The Userscript Runtime

Generate the local userscript from the root config:

```powershell
pwsh .\scripts\compile-userscript.ps1
```

The generated `easy_email_proxy.local.user.js` is intentionally ignored and must
not be committed.

## 5. Deploy The Cloudflare Temp Mail Runtime

Use the single operator entrypoint:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1
```

For a dry run:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1 -DryRun -NoRoutingSync
```

## 6. Validate The Repositories

Service runtime:

```powershell
Set-Location service/base
npm install
npm run typecheck
npm run test
npm run build
```

Cloudflare worker upstream:

```powershell
Set-Location upstreams/cloudflare_temp_email/worker
corepack pnpm install
corepack pnpm lint
corepack pnpm build
```

Cloudflare frontend upstream:

```powershell
Set-Location ..\frontend
corepack pnpm install
corepack pnpm test
corepack pnpm build
```

## 7. Rule Of Thumb

- edit only the root `config.yaml`
- do not hand-edit generated files
- if a generated config looks stale, rerender it from the root file
