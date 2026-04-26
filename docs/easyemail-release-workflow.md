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
