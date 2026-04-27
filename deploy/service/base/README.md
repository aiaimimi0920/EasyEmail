# EasyEmail Service Deployment

This directory contains deployment assets for `service/base`.

EasyEmail is deployed as an independent service runtime and is not expected to
share the same compose boundary as unrelated application services.

## Core Runtime Contract

- runtime config path: `/etc/easy-email/config.yaml`
- runtime state dir: `/var/lib/easy-email`
- minimal environment variables:
  - `EASY_EMAIL_CONFIG_PATH`
  - `EASY_EMAIL_STATE_DIR`
  - `EASY_EMAIL_RESET_STORE_ON_BOOT`

Provider and service settings belong in the root `config.yaml`, not in a large
set of `EASY_EMAIL_SERVICE_*` environment variables.

The runtime config that the container consumes is generated from the root
`config.yaml` by `scripts/render-derived-configs.ps1`.
Container-only environment variables are generated into `config/runtime.env`
from the same root config.

If a trusted machine does not have a local `/etc/easy-email/config.yaml`, the
container can also bootstrap from a local
`/etc/easy-email/bootstrap/r2-bootstrap.json` file. In that mode the entrypoint
downloads both:

- `/etc/easy-email/config.yaml`
- `/etc/easy-email/runtime.env`

from a private Cloudflare R2 bucket before starting the Node runtime.

## Key Files

- `Dockerfile`: build the EasyEmail service image
- `docker-compose.yaml`: local Docker Compose entrypoint
- `config.template.yaml`: internal base template used by the render script
- `docker-entrypoint.sh`: container startup entrypoint
- `publish-ghcr-easy-email-service.ps1`: GHCR publish helper
- `smoke-easy-email-docker-api.ps1`: smoke helper for the container API

## Quick Start

From the repository root:

```powershell
Set-Location C:\Users\Public\nas_home\AI\GameEditor\EasyEmail
pwsh .\scripts\deploy-service-base.ps1
```

Default host port:

- `http://127.0.0.1:18081`

## Notes

- the public repository keeps only templates and empty-state placeholders
- live runtime state must not be committed
- if you want to render the config without starting Docker, use
  `scripts/render-derived-configs.ps1 -ServiceBase`

## Smoke Test

```powershell
pwsh .\deploy\service\base\smoke-easy-email-docker-api.ps1 -Rebuild -ApiKey "<server.apiKey>"
```

## GHCR Publish

```powershell
pwsh .\deploy\service\base\publish-ghcr-easy-email-service.ps1 -Owner <github-owner> -Push
```

If `publishing.ghcr` is filled in inside the root `config.yaml`, the publish
script can read the registry owner, username, and token from there.

## GitHub Actions Publish

The repository also includes `.github/workflows/publish-service-base-ghcr.yml`.

It supports:

- automatic publish on tag push
- manual publish through `workflow_dispatch`
- pre-push smoke validation for the `service/base` container
- rendering the final `service/base` runtime config and uploading it to private R2

## Start A Non-Conflicting GHCR Instance

To pull a published GHCR image and start it locally without reusing the default
container name, port, or state directory, use the root deployment script with
an instance name:

```powershell
pwsh .\scripts\deploy-service-base.ps1 `
  -ConfigPath .\config.yaml `
  -NoBuild `
  -Pull `
  -Image ghcr.io/<owner>/easy-email-service:<tag> `
  -InstanceName ghcr-smoke `
  -HostPort 18082
```

Then validate that isolated instance with:

```powershell
pwsh .\scripts\test-service-base-instance.ps1 `
  -ConfigPath .\config.yaml `
  -BaseUrl http://127.0.0.1:18082 `
  -RequestRandomSubdomain
```

## Start From R2 Bootstrap Instead Of Local Config

If you want the image to fetch its config from a private R2 bucket on first
boot:

1. Upload the rendered runtime config with:

```powershell
pwsh .\scripts\upload-service-base-r2-config.ps1 `
  -ConfigPath .\config.yaml `
  -AccountId <cloudflare-account-id> `
  -Bucket <private-bucket> `
  -AccessKeyId <upload-access-key-id> `
  -SecretAccessKey <upload-secret-access-key> `
  -ConfigObjectKey <config-object-key> `
  -RuntimeEnvObjectKey <env-object-key> `
  -ManifestOutput .\.tmp\service-base-r2-manifest.json
```

2. Generate a local bootstrap file for the trusted machine:

```powershell
pwsh .\scripts\write-service-base-r2-bootstrap.ps1 `
  -ManifestPath .\.tmp\service-base-r2-manifest.json `
  -AccessKeyId <client-read-access-key-id> `
  -SecretAccessKey <client-read-secret-access-key> `
  -OutputPath .\.tmp\service-base-r2-bootstrap.json
```

3. Start an isolated instance without rendering a local config:

```powershell
pwsh .\scripts\deploy-service-base.ps1 `
  -ConfigPath .\config.yaml `
  -BootstrapFile .\.tmp\service-base-r2-bootstrap.json `
  -InstanceName r2-bootstrap `
  -HostPort 18084
```
