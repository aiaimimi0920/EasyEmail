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

- `http://127.0.0.1:18080`

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
