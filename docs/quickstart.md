# Quick Start

## 1. Clone The Repository

```powershell
git clone <your-repo-url> EasyEmail
Set-Location EasyEmail
```

## 2. Work On The Local Service Runtime

```powershell
Set-Location service/base
npm install
npm run typecheck
npm run test
npm run build
```

Run the service locally:

```powershell
npm run dev
```

## 3. Work On The Userscript Runtime

Template assets live in `runtimes/userscript`.

Private local setup:

1. Copy `easy_email_proxy.secrets.example.json` to `easy_email_proxy.secrets.local.json`
2. Fill in your private local values
3. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\runtimes\userscript\generate_local_userscript.ps1
```

The generated `easy_email_proxy.local.user.js` is intentionally ignored and must
not be committed.

## 4. Work On The Cloudflare Temp Mail Upstream Runtime

Worker:

```powershell
Set-Location upstreams/cloudflare_temp_email/worker
corepack pnpm install
corepack pnpm lint
corepack pnpm build
```

Frontend:

```powershell
Set-Location ..\frontend
corepack pnpm install
corepack pnpm test
corepack pnpm build
```

## 5. Deployment Assets

- `deploy/service/base`
- `deploy/upstreams/cloudflare_temp_email`

Use the example or template files first. Do not commit live deployment state.

