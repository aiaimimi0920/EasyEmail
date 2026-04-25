# Upstream Sync

## Purpose

`upstreams/cloudflare_temp_email` stays inside this monorepo so public
contributors only need one repository. It is still maintained as a distinct
upstream sync boundary.

## Rule

External contributors open PRs here. Maintainers decide whether a change should:

- stay as a monorepo-local patch
- be carried on top of upstream
- be proposed back to the upstream project separately

## Maintainer Workflow

1. Sync the maintained Cloudflare temp mail source from its upstream repository
   in a dedicated maintainer workspace.
2. Resolve conflicts there first.
3. Copy or import the reviewed result into `upstreams/cloudflare_temp_email`.
4. Keep local patches narrow and easy to identify.
5. Document any intentional divergence in the PR summary.

## Guardrails

- Do not scatter Cloudflare temp mail code into `service/base`.
- Keep upstream-only deployment config sanitized.
- Keep `worker/wrangler.toml` public-safe and template-like.

