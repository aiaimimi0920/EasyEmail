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

Default Docker network:

- `EasyAiMi`

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

1. Upload the rendered runtime config, userscript settings, and unified
distribution manifest with:

```powershell
pwsh .\scripts\upload-service-base-r2-config.ps1 `
  -ConfigPath .\config.yaml `
  -AccountId <cloudflare-account-id> `
  -Bucket <private-bucket> `
  -AccessKeyId <upload-access-key-id> `
  -SecretAccessKey <upload-secret-access-key> `
  -ConfigObjectKey <config-object-key> `
  -RuntimeEnvObjectKey <env-object-key> `
  -UserscriptSettingsObjectKey <userscript-settings-object-key> `
  -ManifestObjectKey <manifest-object-key> `
  -ManifestOutput .\.tmp\service-base-r2-manifest.json
```

2. Either generate a local bootstrap file:

```powershell
pwsh .\scripts\write-service-base-r2-bootstrap.ps1 `
  -ManifestPath .\.tmp\service-base-r2-manifest.json `
  -AccessKeyId <client-read-access-key-id> `
  -SecretAccessKey <client-read-secret-access-key> `
  -OutputPath .\.tmp\service-base-r2-bootstrap.json
```

3. Or generate an EasyEmail import-code key pair once, keep the private key
local, and let GitHub Actions emit encrypted import-code artifacts for later
decryption:

```powershell
pwsh .\scripts\generate-import-code-keypair.ps1 `
  -PublicKeyOutputPath .\.tmp\easyemail-import-code-owner-public.txt `
  -PrivateKeyOutputPath .\.tmp\easyemail-import-code-owner-private.txt
```

4. Start an isolated instance without rendering a local config by using either
the bootstrap file or an import code:

```powershell
pwsh .\scripts\deploy-service-base.ps1 `
  -ConfigPath .\config.yaml `
  -BootstrapFile .\.tmp\service-base-r2-bootstrap.json `
  -InstanceName r2-bootstrap `
  -HostPort 18084
```

```powershell
pwsh .\scripts\deploy-service-base.ps1 `
  -ConfigPath .\config.yaml `
  -ImportCode <easyemail-import-v1...> `
  -InstanceName r2-import-code `
  -HostPort 18087
```

When the bootstrap/import code has `syncEnabled=true`, the container keeps the
bootstrap metadata in its state directory and checks the remote manifest every
two hours. If the remote config changed, the container pulls the updated
artifacts and restarts itself automatically. Clear or replace the import code
at the next launch by updating the bootstrap file or rerunning
`deploy-service-base.ps1 -ImportCode ...`.

## Cloudflare Sender Matrix

`service/base` now supports a stable `cloudflare_temp_email` sender mailbox for
cross-provider receive and OTP validation.

Relevant root-config fields:

- `cloudflareMail.worker.vars.RESEND_TOKEN`
- `cloudflareMail.sending.domains`
- `cloudflareMail.sending.preferredSenderDomain`
- `cloudflareMail.sending.preferredSenderLocalPart`

Recommended example:

```yaml
cloudflareMail:
  sending:
    domains:
      - tx-mail.example.com
    preferredSenderDomain: tx-mail.example.com
    preferredSenderLocalPart: matrixsender
```

When `RESEND_TOKEN` is present, the Cloudflare deploy scripts bootstrap the
Resend sending domain, verify its DNS records through Cloudflare, and let
`service/base` recover the same sender mailbox across runs instead of creating
a fresh sender address every time.

The real sender-matrix script is:

- [test-easyemail-cloudflare-sender-matrix.ps1](C:\Users\Public\nas_home\AI\GameEditor\EasyEmail\scripts\test-easyemail-cloudflare-sender-matrix.ps1)

Current defaults:

- recipient verification is skipped automatically when a Resend token is
  configured
- add `-ForceRecipientVerification` if you intentionally want to test the older
  Cloudflare recipient-verification flow
