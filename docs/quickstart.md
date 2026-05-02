# Quick Start

## 1. Clone The Repository

```powershell
git clone <your-repo-url> EasyEmail
Set-Location EasyEmail
```

## 2. Prepare The Toolchain

Use Node.js `20.19+` and enable Corepack once so the `pnpm` subprojects use the
expected package manager version.

```powershell
corepack enable
```

The repository root includes `.nvmrc` and `.node-version` if you use a version
manager.

## 3. Edit The Root Config Once

Copy `config.example.yaml` to `config.yaml` and edit only that file.

All service, userscript, and Cloudflare deployment settings are derived from it.

## 4. Prepare The Local Service Runtime

Render the service config from the root config and start the service through
the repository-root host wrapper:

```powershell
pwsh .\deploy-host.ps1
```

That root entrypoint preserves the validated deployment contract:

- it deploys the `service/base` runtime through the existing operator scripts
- it keeps the stable Docker network alias `easy-email-service`
- it defaults to the external Docker network `EasyAiMi`

The lower-level entrypoint is still available when you need direct control:

```powershell
pwsh .\scripts\deploy-service-base.ps1
```

If you only want to render the generated config file without starting Docker:

```powershell
pwsh .\scripts\render-derived-configs.ps1 -ServiceBase
```

## 5. Work On The Userscript Runtime

Generate the local userscript from the root config:

```powershell
pwsh .\scripts\compile-userscript.ps1
```

The generated file is built from the root `config.yaml`, including its
`userscript.secrets` section. That root config is the single source of operator
secrets for userscript generation.

The generated `easy_email_proxy.local.user.js` is intentionally ignored and must
not be committed.

## 6. Deploy The Cloudflare Temp Mail Runtime

Use the single operator entrypoint:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1
```

If you also want outbound sender-matrix testing through a stable
`cloudflare_temp_email` sender mailbox, add these root-config fields before the
deploy:

- `cloudflareMail.worker.vars.RESEND_TOKEN`
- `cloudflareMail.sending.domains`
- `cloudflareMail.sending.preferredSenderDomain`
- `cloudflareMail.sending.preferredSenderLocalPart`

With those configured, deploy bootstrap will create or reuse the Resend sending
domain, write the required DNS records into Cloudflare, verify the domain, and
let EasyEmail reuse a sender such as `matrixsender@tx-mail.example.com`.

With the current large explicit subdomain pool, the deploy scripts now default
to the config's DNS sync mode, and the recommended default is `wildcard`.
Ordinary updates should not force `exact` unless you intentionally want
per-subdomain DNS records.

For a first deploy where the Cloudflare worker or D1 database does not exist
yet, use bootstrap mode:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1 -BootstrapMissingResources
```

If you changed only worker or frontend code and did not rebuild the explicit
subdomain pool, a normal deploy is enough. The routing-state rebuild is no
longer part of the default update path.

If you intentionally changed the explicit subdomain pool and want to rebuild
Cloudflare Email Routing state, add:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1 -ForceRoutingStateSync
```

For a dry run:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1 -DryRun -NoRoutingSync
```

To back up and remove an existing Cloudflare mail deployment:

```powershell
pwsh .\scripts\remove-cloudflare-email.ps1
```

If you want GitHub-hosted deployment later, the matching workflow can read the
granular `EASYEMAIL_CF_*` secrets documented in
[github-actions-secrets.md](./github-actions-secrets.md). That keeps hosted
deployment fork-friendly because users can fill each field separately instead
of maintaining a full YAML secret.

That same workflow also supports mode 1 bootstrap through the
`bootstrap_missing_resources` workflow input.

See [github-actions-secrets.md](./github-actions-secrets.md) for the complete
secret inventory used by the hosted deployment workflows.

## 7. Publish The Service Image And Deploy Cloudflare Together

Use the root release entrypoint when you want to publish the `service/base`
Docker image to GHCR, run the Cloudflare deployment flow, and then validate the
result:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1
```

If the Cloudflare side is a first deploy, you can pass the same bootstrap flag
through the root release entrypoint:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1 -BootstrapMissingResources
```

Safe dry run:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1 -DryRun -NoRoutingSync
```

## 8. Validate The Repositories

Repository-wide validation:

```powershell
pwsh .\scripts\test-all.ps1
```

Standalone userscript validation:

```powershell
pwsh .\scripts\validate-userscript.ps1
```

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

## 9. Rule Of Thumb

- edit only the root `config.yaml`
- do not hand-edit generated files
- if a generated config looks stale, rerender it from the root file
