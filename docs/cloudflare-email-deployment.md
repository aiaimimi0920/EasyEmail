# Cloudflare Email Deployment

This is the shortest path for an operator or AI agent that needs to deploy the
Cloudflare temp-mail side of EasyEmail.

## Single Config Rule

Only edit the repository root `config.yaml`.

The deploy scripts render everything else they need:

- `scripts/render-derived-configs.ps1` renders the worker `wrangler` config
- `scripts/deploy-cloudflare-email.ps1` calls the quick deploy flow
- `scripts/quick-deploy-cloudflare-mail.ps1` builds the frontend and deploys the
  worker using the rendered config

## Start Here

1. Copy `config.example.yaml` to `config.yaml`.
2. Fill in the `cloudflareMail` section in the root config.
3. If you want routing synchronization, fill in `cloudflareMail.routing.plan`
   and the routing secrets in the root `config.yaml`.
4. Run:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1
```

If you also want to publish the `service/base` image to GHCR in the same
operator flow, use:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1
```

The root release command also performs a post-deploy Cloudflare health check
and version readback by default.

If you want GitHub-hosted automation instead of a local operator shell, use the
repository workflow:

- `.github/workflows/deploy-cloudflare-email.yml`

It supports both tag pushes and `workflow_dispatch`. Store the same root
operator config in the `EASYEMAIL_OPERATOR_CONFIG` repository secret when you
want GitHub-hosted deployment, or store only the `cloudflareMail` overlay in
`EASYEMAIL_CLOUDFLARE_MAIL_CONFIG` if you prefer a narrower secret scope. For
manual dry-run validation, the workflow can fall back to `config.example.yaml`
when no operator config secret is present.

For a real GitHub-hosted deploy, you also need the Cloudflare runner secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Those are what let `wrangler deploy` authenticate against your Cloudflare
account during the workflow run.

## What The Root Config Needs

The deploy scripts read the root `config.yaml`, specifically:

- `cloudflareMail.publicBaseUrl`
- `cloudflareMail.publicDomain`
- `cloudflareMail.worker.vars.PASSWORDS`
- `cloudflareMail.worker.vars.JWT_SECRET`
- `cloudflareMail.routing.mode`
- `cloudflareMail.routing.plan.subdomainLabelPool`
- `cloudflareMail.routing.plan.domains`
- `cloudflareMail.routing.controlCenterDnsToken`
- `cloudflareMail.routing.cloudflareGlobalAuth.authEmail`
- `cloudflareMail.routing.cloudflareGlobalAuth.globalApiKey`

Concrete example:

```yaml
cloudflareMail:
  publicBaseUrl: https://mail.example.com
  publicDomain: mail.example.com
  worker:
    vars:
      PASSWORDS:
        - change-me
      JWT_SECRET: change-me
  routing:
    mode: exact
    plan:
      subdomainLabelPool:
        - alpha
        - beta
        - gamma
      domains:
        - mail.example.com
        - example.com
        - "*.example.com"
    controlCenterDnsToken: ""
    cloudflareGlobalAuth:
      authEmail: ""
      globalApiKey: ""
```

## What The Scripts Do

- `scripts/render-derived-configs.ps1` merges the root config onto the internal
  worker template and writes a temporary `wrangler` file.
- `scripts/quick-deploy-cloudflare-mail.ps1` uses that rendered worker config to
  build the frontend and deploy the worker.
- `scripts/deploy-cloudflare-email.ps1` is the short operator entrypoint.

## Safe Dry Run

Use dry run mode if you want to verify the build and config flow without
publishing:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1 -DryRun -NoRoutingSync
```

## For AI Agents

When reading this repository, the relevant order is:

1. [configuration.md](./configuration.md)
2. [scripts/render-derived-configs.ps1](../scripts/render-derived-configs.ps1)
3. [scripts/deploy-cloudflare-email.ps1](../scripts/deploy-cloudflare-email.ps1)
4. [scripts/quick-deploy-cloudflare-mail.ps1](../scripts/quick-deploy-cloudflare-mail.ps1)
5. [deploy/upstreams/cloudflare_temp_email/README.md](../deploy/upstreams/cloudflare_temp_email/README.md)

This gives the AI a single operator path and the supporting detail underneath it.
