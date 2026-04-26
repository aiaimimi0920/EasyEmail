# Release Tagging

Use a predictable tag format so the GitHub Actions release workflows know which
parts of EasyEmail should be published.

The workflows validate tag names through
[`scripts/validate-release-tag.py`](../scripts/validate-release-tag.py), so an
invalid tag fails fast before publishing or deployment begins.

## Recommended Tag Families

### `vX.Y.Z`

Use semantic version tags such as `v1.8.0` for coordinated public releases.

What it triggers:

- `publish-service-base-ghcr.yml`
- `deploy-cloudflare-email.yml`

Recommended when:

- the release is user-facing
- you want one shared version across GHCR and Cloudflare mail
- you want the GitHub Release title to match the public version

### `release-YYYYMMDD-NNN`

Use operational rollout tags such as `release-20260427-001` when you want a
tracked deployment without claiming a new public semantic version.

What it triggers:

- `publish-service-base-ghcr.yml`
- `deploy-cloudflare-email.yml`

Recommended when:

- the change is deployment-oriented
- you want a durable audit tag for infra or operator changes
- you need multiple tagged releases in the same day

### `service-base-YYYYMMDD-NNN`

Use service-only tags such as `service-base-20260427-001` when you want to
publish only the `service/base` image to GHCR.

What it triggers:

- `publish-service-base-ghcr.yml`

Recommended when:

- only the container image changed
- Cloudflare mail does not need to be redeployed
- you want image-only validation and release notes

## Manual Runs

Use `workflow_dispatch` when:

- you need a dry-run validation
- you want to force a publish/deploy without creating a tag first
- you want to override options such as platform, health checks, or routing sync

Manual runs are still recorded in the release manifests, but they use the
`manual` channel instead of a tag-driven channel.

## Practical Rules

- Prefer `vX.Y.Z` for public milestones.
- Prefer `release-YYYYMMDD-NNN` for operator rollouts and infra changes.
- Prefer `service-base-YYYYMMDD-NNN` for image-only publishing.
- Avoid ad-hoc tags such as `test`, `prod`, or `latest-release`; they do not
  describe scope and are harder to audit later.
