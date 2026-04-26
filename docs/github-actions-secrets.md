# GitHub Actions Secrets

This repository uses GitHub repository secrets for hosted deployment. Do not
commit these values into source files.

## Cloudflare Deployment Secrets

These are required for `.github/workflows/deploy-cloudflare-email.yml`.

| Secret name | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Cloudflare account identifier used by `wrangler deploy`. |
| `CLOUDFLARE_API_TOKEN` | Yes | Cloudflare API token with the permissions needed to deploy the worker and, if routing sync is enabled, manage DNS/email-routing records. |
| `EASYEMAIL_OPERATOR_CONFIG` | Optional | Full root `config.yaml` serialized as YAML. Use this when you want the workflow to materialize the entire operator config from one secret. |
| `EASYEMAIL_CLOUDFLARE_MAIL_CONFIG` | Optional | YAML overlay containing only the `cloudflareMail` section. Use this when you want a narrower secret scope. |

Use either `EASYEMAIL_OPERATOR_CONFIG` or `EASYEMAIL_CLOUDFLARE_MAIL_CONFIG`.
If both are present, the workflow prefers the full operator config.

## GHCR Publish Secrets

These are not required for `.github/workflows/publish-service-base-ghcr.yml`.
That workflow uses `GITHUB_TOKEN` provided by GitHub Actions.

## Local Operator Config

For local scripts, the repository root `config.yaml` remains the single source of
operator secrets for:

- `userscript.secrets`
- `serviceBase.runtime`
- `cloudflareMail.worker.vars`
- `cloudflareMail.routing.*`
- `publishing.*`

Keep that file local and do not commit it.

## Where To Add Them

In GitHub, add them at:

`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

Fork users should add the same secret names to their forked repository if they
want hosted deployment from their fork.
