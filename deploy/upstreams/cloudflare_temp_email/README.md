# cloudflare_temp_email Deployment Workspace

This directory contains deployment helpers for
`upstreams/cloudflare_temp_email`.

It is the right place for:

- deployment flow scripts
- operational helper material that should not live in the main source tree

## Current Layout

- source code: `upstreams/cloudflare_temp_email`
- deployment helpers: `deploy/upstreams/cloudflare_temp_email/scripts`
- repository-level documentation: `docs/`

## Notes

- keep actual product code changes inside `upstreams/cloudflare_temp_email`
- keep deployment-only logic inside this directory
- keep operator config in the repository root `config.yaml`
- validate deployment completion through `GET /open_api/settings`
- ensure `domains` and `randomSubdomainDomains` are exposed as expected

There is no second deploy config directory anymore. The supported operator flow
is:

1. edit the repository root `config.yaml`
2. run `scripts/deploy-cloudflare-email.ps1` or `scripts/quick-deploy-cloudflare-mail.ps1`
3. let the wrapper scripts generate any temporary JSON or TOML files they need

## Script Inventory

- `deploy_mailcreate_wrangler.ps1`
- `sync_email_routing_dns.ps1`
- `sync_email_routing_dns.py`
- `sync_email_routing_state.py`
- `verify_email_routing_tail_*.ps1` style helpers

## Cloudflare Token Requirement

Before running `sync_email_routing_dns.ps1`, provide a Cloudflare API token
with:

- `Zone Read`
- `DNS Read`
- `DNS Edit`

Use either:

- environment variable `CLOUDFLARE_API_TOKEN`
- script argument `-ApiToken`
