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

It supports both tag pushes and `workflow_dispatch`. For GitHub-hosted
deployment, configure the granular `EASYEMAIL_CF_*` repository secrets
documented in [github-actions-secrets.md](./github-actions-secrets.md). That
mode lets the operator fill one secret per field instead of pasting a multi-line
YAML document.

For manual dry-run validation, the workflow can fall back to
`config.example.yaml` when no `EASYEMAIL_CF_*` secrets are present.

The full secret inventory is documented in
[github-actions-secrets.md](./github-actions-secrets.md).

## Supported Deployment Modes

The repository now supports both deployment modes through the same script path:

1. **Mode 1: first deploy**
   This is the bootstrap path for an account where the EasyEmail worker, D1
   database, and worker custom domain have not been created yet.
2. **Mode 2: update deploy**
   This is the normal redeploy path when Cloudflare resources already exist and
   only code or config changed.

For large explicit subdomain pools, the important rule is:

- first deploy or subdomain-pool rebuild: run bootstrap and routing-state sync
- ordinary code update: skip the heavy routing-state rebuild

The operator entrypoint stays the same:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1
```

To force mode 1 bootstrap locally, add:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1 -BootstrapMissingResources
```

For GitHub Actions, use the workflow input `bootstrap_missing_resources=true`.

For the current production-sized domain pool, `wildcard` should be the default
DNS sync mode. The hosted workflow uses `sync_mode=wildcard` for manual runs,
and tag-triggered deploys now fall back to the config value instead of forcing
`exact`. Keep `exact` for deliberate cases only; it can exceed Cloudflare DNS
record quotas when the label pool is large.

If you only changed Worker or frontend code and did not change the explicit
subdomain pool, do not force routing-state sync. The update path can reuse the
already registered Cloudflare Email Routing subdomains.

If you changed the explicit domain pool or want to rebuild it deliberately, use:

- local script: `-ForceRoutingStateSync`
- GitHub Actions input: `force_routing_state_sync=true`

## What The Root Config Needs

The deploy scripts read the root `config.yaml`, specifically:

- `cloudflareMail.publicBaseUrl`
- `cloudflareMail.publicDomain`
- `cloudflareMail.publicZone`
- `cloudflareMail.worker.vars.PASSWORDS`
- `cloudflareMail.worker.vars.ADMIN_PASSWORDS`
- `cloudflareMail.worker.vars.JWT_SECRET`
- `cloudflareMail.worker.d1_databases[0].database_name`
- `cloudflareMail.routing.mode`
- `cloudflareMail.routing.stateSyncPolicy`
- `cloudflareMail.routing.plan.subdomainLabelPool`
- `cloudflareMail.routing.plan.domains`
- `cloudflareMail.routing.controlCenterDnsToken`
- `cloudflareMail.routing.cloudflareGlobalAuth.authEmail`
- `cloudflareMail.routing.cloudflareGlobalAuth.globalApiKey`

For mode 1, the bootstrap section is also relevant:

- `cloudflareMail.bootstrap.enabled`
- `cloudflareMail.bootstrap.createZones`
- `cloudflareMail.bootstrap.accountId`
- `cloudflareMail.bootstrap.zones`
- `cloudflareMail.bootstrap.d1LocationHint`
- `cloudflareMail.bootstrap.d1Jurisdiction`

Concrete example:

```yaml
cloudflareMail:
  publicBaseUrl: https://mail.example.com
  publicDomain: mail.example.com
  publicZone: example.com
  bootstrap:
    enabled: false
    createZones: true
    accountId: ""
    zones:
      - example.com
  worker:
    vars:
      PASSWORDS:
        - change-me
      ADMIN_PASSWORDS:
        - admin-change-me
      JWT_SECRET: change-me
    d1_databases:
      - binding: DB
        database_name: cloudflare-temp-email
        database_id: "00000000-0000-0000-0000-000000000000"
  routing:
    mode: wildcard
    stateSyncPolicy: bootstrap-or-forced
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
  build the frontend, bootstrap missing Cloudflare resources when requested, and
  deploy the worker.
- `scripts/deploy-cloudflare-email.ps1` is the short operator entrypoint.

In mode 1, the quick deploy flow also:

- resolves the target Cloudflare account
- creates missing zones when bootstrap allows it
- creates the D1 database when it does not exist yet
- re-renders a temporary config with the resolved D1 database id
- deploys the worker to the public custom domain
- waits for `/health_check`
- calls the worker admin endpoints to initialize and migrate the D1 schema

For large explicit pools, `cloudflareMail.routing.stateSyncPolicy` controls when
the heavy Email Routing subdomain preparation runs:

- `bootstrap-or-forced`: default. Run it on first deploy or when you explicitly force it.
- `always`: run it on every deploy.
- `never`: skip it entirely.

For the same large explicit pools, `cloudflareMail.routing.mode` should usually
stay on `wildcard`. That still preserves the explicit subdomain pool in the
worker and routing plan, but it avoids exploding the per-zone DNS record count
on every deploy.

## Safe Dry Run

Use dry run mode if you want to verify the build and config flow without
publishing:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1 -DryRun -NoRoutingSync
```

## Remove A Deployed Cloudflare Mail Runtime

If you need to back up the current Cloudflare mail topology and then remove the
deployed worker, custom domain, Email Routing state, managed MX/TXT records,
and D1 database, use:

```powershell
pwsh .\scripts\remove-cloudflare-email.ps1
```

The script writes a backup JSON file under `.tmp/` before it starts deleting
resources.

To preview the deletion plan without mutating Cloudflare resources:

```powershell
pwsh .\scripts\remove-cloudflare-email.ps1 -DryRun
```

## For AI Agents

When reading this repository, the relevant order is:

1. [configuration.md](./configuration.md)
2. [scripts/render-derived-configs.ps1](../scripts/render-derived-configs.ps1)
3. [scripts/deploy-cloudflare-email.ps1](../scripts/deploy-cloudflare-email.ps1)
4. [scripts/quick-deploy-cloudflare-mail.ps1](../scripts/quick-deploy-cloudflare-mail.ps1)
5. [deploy/upstreams/cloudflare_temp_email/README.md](../deploy/upstreams/cloudflare_temp_email/README.md)

This gives the AI a single operator path and the supporting detail underneath it.
