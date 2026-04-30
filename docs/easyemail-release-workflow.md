# EasyEmail Release Workflow

Use the root release script when you want one command to handle both:

- publishing the `service/base` Docker image to GHCR
- deploying the Cloudflare temp-mail runtime
- validating the published image and deployed runtime

## Entry Point

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1
```

## What It Does

- reads the repository root `config.yaml`
- publishes `service/base` through `deploy/service/base/publish-ghcr-easy-email-service.ps1`
- deploys Cloudflare mail through `scripts/deploy-cloudflare-email.ps1`
- runs a `service/base` smoke check from the published image unless skipped
- runs a Cloudflare `health_check` + `open_api/settings` verification unless skipped
- prints the released image tags and detected Cloudflare version

The same entrypoint also supports mode 1 bootstrap for the Cloudflare side:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1 -BootstrapMissingResources
```

That switch is only forwarded into the Cloudflare deploy path. It lets the
release flow create missing Cloudflare zones and D1 resources before deploying
the worker.

For GitHub-hosted automation, there are also dedicated workflows under
`.github/workflows/`:

- `publish-service-base-ghcr.yml` for GHCR image publishing
- `deploy-cloudflare-email.yml` for Cloudflare runtime deployment and health
  checks

Both workflows now emit richer JSON release manifests and render their human
readable notes from templates under `.github/release-notes/`.

The release manifests now carry audit-oriented metadata such as:

- repository and workflow run identity
- triggering event, actor, ref, and commit sha
- matched file scope from the path gate
- release channel and validation status
- published tags, digests, and deployed runtime details

When both GHCR publishing and Cloudflare deployment run for the same tag, they
now update the same GitHub Release body by managing independent markdown
sections instead of overwriting each other.

Both workflows also validate release tags before they publish or deploy. The
validation rules live in [validate-release-tag.py](../scripts/validate-release-tag.py).

If you need the exact GitHub secret names for hosted deployment, see
[github-actions-secrets.md](./github-actions-secrets.md).

## Static Sender + Resend Release Path

The Cloudflare side of the release workflow now supports a formal outbound-mail
path for EasyEmail sender-matrix testing:

- configure `cloudflareMail.worker.vars.RESEND_TOKEN`
- configure `cloudflareMail.sending.domains`
- optionally configure:
  - `cloudflareMail.sending.preferredSenderDomain`
  - `cloudflareMail.sending.preferredSenderLocalPart`

When those fields are present, the Cloudflare deploy step now performs extra
bootstrap work before the worker deploy:

1. create or reuse the Resend sending domain
2. upsert the required DNS records into the owning Cloudflare zone
3. wait for the Resend domain to become `verified`
4. deploy the worker with the active `RESEND_TOKEN`

That means the root release flow can now publish `service/base`, deploy the
Cloudflare runtime, and then run sender-matrix validation against a stable
sender mailbox such as `matrixsender@tx-mail.example.com`.

The static sender mailbox is also recoverable across runs. If the preferred
sender already exists, EasyEmail restores the existing mailbox session through
the worker admin API instead of failing on `Address already exists`.

The Cloudflare deploy workflow now includes a slim post-deploy sender-matrix
acceptance step by default. It validates these providers through a locally
started `service/base` verifier:

- `cloudflare_temp_email`
- `mailtm`
- `m2u`

Manual runs can disable that acceptance step with the workflow input
`run_sender_matrix=false`.

## Useful Flags

Skip the Cloudflare deploy and publish only the service image:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1 -SkipCloudflareMail
```

Skip GHCR and only deploy Cloudflare mail:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1 -SkipServiceBaseGhcr
```

Dry run the whole flow:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1 -DryRun -NoRoutingSync
```

Skip the post-release validation steps:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1 -SkipServiceBaseSmoke -SkipCloudflareHealthCheck
```

Override the published service image version:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1 -ServiceBaseVersion release-20260426-001
```

## Config Requirements

The script reads:

- `serviceBase.image`
- `publishing.ghcr.registry`
- `publishing.ghcr.owner`
- `publishing.ghcr.username`
- `publishing.ghcr.token`
- `cloudflareMail.*`

Keep all of these in the root `config.yaml`.

## Tagging Policy

Use the documented tag families so the workflows can infer the right release
channel and scope:

- `vX.Y.Z` for coordinated public releases
- `release-YYYYMMDD-NNN` for operational tagged rollouts
- `service-base-YYYYMMDD-NNN` for image-only GHCR publishing

The full convention is documented in [release-tagging.md](./release-tagging.md).
