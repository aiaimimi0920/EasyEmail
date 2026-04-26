# GitHub Actions Secrets

This repository uses GitHub repository secrets for hosted deployment. Do not
commit these values into source files.

Add them in GitHub at:

`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

Fork users must add the same secret names to their own fork if they want to run
hosted deployment there.

## Secret Input Modes

`.github/workflows/deploy-cloudflare-email.yml` supports three input modes.

1. `EASYEMAIL_OPERATOR_CONFIG`
This is the full root `config.yaml` stored as one multi-line secret.

2. `EASYEMAIL_CLOUDFLARE_MAIL_CONFIG`
This is a narrower multi-line YAML secret containing only the `cloudflareMail`
section.

3. `EASYEMAIL_CF_*`
This is the recommended fork-friendly mode. Each major config item is stored in
its own secret, so users can fill the form item by item without editing a full
YAML document.

If more than one mode is present, the workflow merges them in this order:

1. base `config.example.yaml`
2. `EASYEMAIL_OPERATOR_CONFIG`
3. `EASYEMAIL_CLOUDFLARE_MAIL_CONFIG`
4. `EASYEMAIL_CF_*` granular overrides

That means the granular `EASYEMAIL_CF_*` values win when there is overlap.

## Multi-Line Support

Yes. GitHub Actions secrets support multi-line values.

That matters for:

- `EASYEMAIL_OPERATOR_CONFIG`
- `EASYEMAIL_CLOUDFLARE_MAIL_CONFIG`
- list-style granular secrets such as domain lists or password lists

For list-style granular secrets, this repository accepts either:

- a YAML or JSON array
- one item per line
- a single comma-separated line

Example:

```text
mail.example.com
example.com
*.example.com
```

or:

```json
["mail.example.com", "example.com", "*.example.com"]
```

## Recommended Granular Secrets

These are the recommended itemized secrets for hosted Cloudflare deployment.

### Required For A Real Deployment

| Secret name | Purpose | Format |
| --- | --- | --- |
| `EASYEMAIL_CF_PUBLIC_BASE_URL` | Public site URL, e.g. `https://mail.example.com` | Single line |
| `EASYEMAIL_CF_PUBLIC_DOMAIN` | Primary public domain, e.g. `mail.example.com` | Single line |
| `EASYEMAIL_CF_PASSWORDS` | User login/shared access passwords | Multi-line list |
| `EASYEMAIL_CF_ADMIN_PASSWORDS` | Admin login passwords | Multi-line list |
| `EASYEMAIL_CF_JWT_SECRET` | Worker JWT signing secret | Single line |
| `EASYEMAIL_CF_DOMAINS` | Domain pool used by the worker and routing plan | Multi-line list |
| `EASYEMAIL_CF_SUBDOMAIN_LABEL_POOL` | Random subdomain label pool | Multi-line list |
| `EASYEMAIL_CF_D1_DATABASE_ID` | Cloudflare D1 database ID | Single line |
| `EASYEMAIL_CF_AUTH_EMAIL` | Cloudflare global auth email for deploy/routing | Single line |
| `EASYEMAIL_CF_GLOBAL_API_KEY` | Cloudflare global API key for deploy/routing | Single line |

### Optional But Common

| Secret name | Purpose | Default if omitted | Format |
| --- | --- | --- | --- |
| `EASYEMAIL_CF_WORKER_NAME` | Worker name override | `cloudflare_temp_email` | Single line |
| `EASYEMAIL_CF_WORKER_ENV` | Wrangler environment override | `production` | Single line |
| `EASYEMAIL_CF_PREFIX` | Worker address prefix | from current config/template | Single line |
| `EASYEMAIL_CF_DEFAULT_DOMAINS` | Default domain list for the worker | falls back to `EASYEMAIL_CF_DOMAINS` | Multi-line list |
| `EASYEMAIL_CF_RANDOM_SUBDOMAIN_DOMAINS` | Domains allowed for random subdomain creation | falls back to `EASYEMAIL_CF_DOMAINS` | Multi-line list |
| `EASYEMAIL_CF_ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH` | Enable subdomain label matching | current config/template | `true` / `false` |
| `EASYEMAIL_CF_RANDOM_SUBDOMAIN_LENGTH` | Generated random subdomain length | current config/template | Integer |
| `EASYEMAIL_CF_ENABLE_USER_CREATE_EMAIL` | Allow users to create addresses | current config/template | `true` / `false` |
| `EASYEMAIL_CF_ENABLE_USER_DELETE_EMAIL` | Allow users to delete addresses | current config/template | `true` / `false` |
| `EASYEMAIL_CF_D1_DATABASE_NAME` | D1 database name override | `cloudflare-temp-email` | Single line |
| `EASYEMAIL_CF_D1_DATABASE_BINDING` | D1 binding override | `DB` | Single line |
| `EASYEMAIL_CF_SYNC_ROUTING` | Enable routing sync during deploy | current config/template | `true` / `false` |
| `EASYEMAIL_CF_ROUTING_MODE` | DNS sync mode | current config/template or workflow input | `exact` / `wildcard` |
| `EASYEMAIL_CF_CONTROL_CENTER_DNS_TOKEN` | Control-center DNS token for DNS sync | disabled if omitted | Single line |

## Legacy Aggregate Secrets

These are still supported for operators who prefer to store larger config
blocks:

| Secret name | Purpose | Format |
| --- | --- | --- |
| `EASYEMAIL_OPERATOR_CONFIG` | Entire root `config.yaml` | Multi-line YAML |
| `EASYEMAIL_CLOUDFLARE_MAIL_CONFIG` | Only the `cloudflareMail` section | Multi-line YAML |

## GHCR Publish Secrets

`.github/workflows/publish-service-base-ghcr.yml` does not require a custom
publish secret. It uses the built-in `GITHUB_TOKEN`.

## Local Operator Config

For local scripts, the repository root `config.yaml` remains the single source
of operator secrets for:

- `userscript.secrets`
- `serviceBase.runtime`
- `cloudflareMail.worker.vars`
- `cloudflareMail.routing.*`
- `publishing.*`

Keep that file local and do not commit it.
