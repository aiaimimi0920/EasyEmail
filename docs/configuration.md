# Configuration

The repository uses a single operator-facing config file:

- `config.example.yaml`
- `config.yaml` copied from the example and kept local

## Sections

All operator secrets live in the repository root `config.yaml`. Start by
copying `config.example.yaml` to `config.yaml`, then fill in only the sections
you actually plan to use.

### `userscript`

Used by `scripts/compile-userscript.ps1`.

Required fields:

- `sourcePath`
- `outputPath`
- `secrets.cloudflare_customAuth`
- `secrets.cloudflare_adminAuth`
- `secrets.moemail_apiKey`
- `secrets.gptmail_apiKey`
- `secrets.im215_apiKey`

### `serviceBase`

Used by `scripts/compile-service-base-image.ps1`.

Required fields:

- `context`
- `dockerfile`
- `image`

### `cloudflareMail`

Used by `scripts/quick-deploy-cloudflare-mail.ps1` and
`scripts/deploy-cloudflare-email.ps1`.

This is the section that controls Cloudflare temp mail deployment. If you are
asking "where do I put the Cloudflare deploy secrets?", the answer is: in the
root `config.yaml`, under `cloudflareMail`.

Required fields:

- `projectRoot`
- `workerDir`
- `frontendDir`
- `workerName`
- `workerEnv`
- `buildFrontend`
- `deployWorker`
- `syncRouting`
- `routing.mode`
- `routing.planPath`
- `routing.controlCenterDnsToken`
- `routing.cloudflareGlobalAuth.authEmail`
- `routing.cloudflareGlobalAuth.globalApiKey`

Minimal example:

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

Notes:

- If `syncRouting: false`, you can leave the routing secrets blank.
- If `syncRouting: true`, fill in `routing.controlCenterDnsToken` for DNS sync.
- If you also want routing state sync, fill in
  `routing.cloudflareGlobalAuth.authEmail` and
  `routing.cloudflareGlobalAuth.globalApiKey`.
- Do not commit `config.yaml`.

## Security Rules

- never commit `config.yaml`
- never commit generated local userscripts
- never commit live tokens or auth keys into example files
