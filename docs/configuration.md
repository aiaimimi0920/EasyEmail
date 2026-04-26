# Configuration

EasyEmail uses one human-edited operator config file:

- `config.example.yaml`
- your local copy `config.yaml`

Everything else is derived from that file by scripts.

Internal templates still exist in the repo for generation purposes, but they are
not the user-facing source of truth:

- `deploy/service/base/config.template.yaml`
- `upstreams/cloudflare_temp_email/worker/wrangler.toml.template`

## Source Of Truth

Start by copying `config.example.yaml` to `config.yaml`, then edit only the
root file. The root config is the only place where you should add or change
deployment values, secrets, or runtime overrides.

The render script is:

- `scripts/render-derived-configs.ps1`

It generates derived internal files from the root config:

- `deploy/service/base/config/config.yaml`
- `deploy/service/base/config/runtime.env`
- `.tmp/cloudflare_temp_email.wrangler.toml`

## Sections

### `userscript`

Used by `scripts/compile-userscript.ps1`.

This section contains the browser userscript runtime settings and secrets.
Secrets stay in the root `config.yaml`; no separate secrets file is needed.

### `serviceBase`

Used by `scripts/render-derived-configs.ps1` and `scripts/deploy-service-base.ps1`.

- `serviceBase.context`, `serviceBase.dockerfile`, and `serviceBase.image` are
  build/deploy metadata.
- `serviceBase.containerEnvironment` is an optional key-value map for
  container-only runtime environment variables. It is rendered into
  `deploy/service/base/config/runtime.env`.
- `serviceBase.runtime` is a partial overlay that gets merged onto
  `deploy/service/base/config.template.yaml` to produce the generated runtime
  config.

If you want to change provider settings, server auth, persistence, or other
runtime values, do it under `serviceBase.runtime`.

### `cloudflareMail`

Used by `scripts/render-derived-configs.ps1`,
`scripts/quick-deploy-cloudflare-mail.ps1`, and
`scripts/deploy-cloudflare-email.ps1`.

- `cloudflareMail.publicBaseUrl` and `cloudflareMail.publicDomain` are the
  public-facing worker endpoint.
- `cloudflareMail.worker` is a partial overlay that gets merged onto
  `upstreams/cloudflare_temp_email/worker/wrangler.toml.template`.
- `cloudflareMail.routing.plan` is the routing host plan used to generate the
  temporary plan file for Email Routing sync.

### `publishing`

Used by image publishing and control-center release helper scripts.

- `publishing.ghcr` is read by
  `deploy/service/base/publish-ghcr-easy-email-service.ps1`.
- `publishing.controlCenter` is read by
  `scripts/publish-control-center-release-catalog.ps1`.
- `publishing.controlCenter.releaseCatalogPayloadPath` should point to the
  release-set catalog JSON file that will be posted to the control center.

## Example

```yaml
serviceBase:
  context: .
  dockerfile: deploy/service/base/Dockerfile
  image: easyemail/easy-email-service:local
  containerEnvironment:
    EASY_PROXY_BASE_URL: http://easy-proxy-service:9888
    EASY_PROXY_API_KEY: ""
  runtime:
    server:
      apiKey: ""
    providers:
      cloudflareTempEmail:
        baseUrl: https://mail.example.com
        apiKey: ""
        domain: mail.example.com

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

publishing:
  ghcr:
    registry: ghcr.io
    owner: ""
    username: ""
    token: ""
  controlCenter:
    baseUrl: https://control.example.com
    releaseCatalogPublishPath: /admin/release-set-catalog
    releaseCatalogPayloadPath: ""
    accessClientId: ""
    accessClientSecret: ""
    releasePublishToken: ""
```

## Security Rules

- never commit `config.yaml`
- never commit generated derived files
- never commit live tokens or auth keys into example files
