# Cloudflare Email Deployment

This is the shortest path for an operator or AI agent that needs to deploy the
Cloudflare temp-mail side of EasyEmail.

## Start Here

1. Make sure `config.example.yaml` has been copied to the repository root
   `config.yaml`.
2. Put all Cloudflare temp mail deployment secrets into the root `config.yaml`
   file, under the `cloudflareMail` section.
3. If you want routing synchronization, fill in the routing secrets as well.
4. Run the direct deploy entrypoint:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1
```

## What The Config Needs

The deploy script does not read secrets from scattered files. It reads the
repository root `config.yaml`, specifically:

```yaml
cloudflareMail:
  ...
```

Minimum fields:

- `cloudflareMail.projectRoot`
- `cloudflareMail.workerDir`
- `cloudflareMail.frontendDir`
- `cloudflareMail.workerName`
- `cloudflareMail.workerEnv`
- `cloudflareMail.buildFrontend`
- `cloudflareMail.deployWorker`

If routing sync is enabled:

- `cloudflareMail.routing.mode`
- `cloudflareMail.routing.planPath`
- `cloudflareMail.routing.controlCenterDnsToken`
- `cloudflareMail.routing.cloudflareGlobalAuth.authEmail`
- `cloudflareMail.routing.cloudflareGlobalAuth.globalApiKey`

Concrete example:

```yaml
cloudflareMail:
  projectRoot: upstreams/cloudflare_temp_email
  workerDir: worker
  frontendDir: frontend
  workerName: cloudflare_temp_email
  workerEnv: production
  buildFrontend: true
  deployWorker: true
  syncRouting: false
  routing:
    mode: exact
    planPath: deploy/upstreams/cloudflare_temp_email/config/subdomain_pool_plan_20260402.toml
    controlCenterDnsToken: ""
    cloudflareGlobalAuth:
      authEmail: ""
      globalApiKey: ""
```

Interpretation:

- Only deploying frontend + worker: set `syncRouting: false`, leave routing
  secrets blank.
- Deploying and syncing DNS records: set `syncRouting: true`, fill in
  `controlCenterDnsToken`.
- Deploying and syncing Cloudflare Email Routing state: also fill in
  `authEmail` and `globalApiKey`.

## What The Script Does

The direct deploy script calls the existing quick deploy workflow and keeps the
operator flow in one place:

- builds the Cloudflare frontend
- deploys the worker
- optionally syncs Email Routing state and DNS

## Safe Dry Run

Use the dry run mode if you want to verify the build and config flow without
publishing:

```powershell
pwsh .\scripts\deploy-cloudflare-email.ps1 -DryRun -NoRoutingSync
```

## For AI Agents

When reading this repository, the relevant order is:

1. [configuration.md](./configuration.md)
2. [cloudflare-email-deployment.md](./cloudflare-email-deployment.md)
3. [scripts/deploy-cloudflare-email.ps1](../scripts/deploy-cloudflare-email.ps1)
4. [scripts/quick-deploy-cloudflare-mail.ps1](../scripts/quick-deploy-cloudflare-mail.ps1)
5. [deploy/upstreams/cloudflare_temp_email/README.md](../deploy/upstreams/cloudflare_temp_email/README.md)

This gives the AI a single operator path and the supporting detail underneath it.
