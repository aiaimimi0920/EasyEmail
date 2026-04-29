# GitHub Actions Secrets

This repository uses GitHub repository secrets for hosted deployment. Do not
commit these values into source files.

Add them in GitHub at:

`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

Fork users must add the same secret names to their own fork if they want to run
hosted deployment there. Secret values do not transfer to forks, and fork users
cannot read the values stored in this repository.

## Supported Secret Mode

`.github/workflows/deploy-cloudflare-email.yml` now uses only the granular
`EASYEMAIL_CF_*` secret set.

Each secret maps to one field or one list, so operators can fill the GitHub
Actions secret screen item by item instead of maintaining a large YAML document.

## Multi-Line Support

Yes. GitHub Actions secrets support multi-line values.

That matters for list-style secrets such as:

- `EASYEMAIL_CF_PASSWORDS`
- `EASYEMAIL_CF_ADMIN_PASSWORDS`
- `EASYEMAIL_CF_DOMAINS`
- `EASYEMAIL_CF_DEFAULT_DOMAINS`
- `EASYEMAIL_CF_RANDOM_SUBDOMAIN_DOMAINS`
- `EASYEMAIL_CF_SUBDOMAIN_LABEL_POOL`

For these list-style secrets, this repository accepts either:

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

## Required For A Real Cloudflare Deployment

| Secret name | Purpose | Format |
| --- | --- | --- |
| `EASYEMAIL_CF_PUBLIC_BASE_URL` | Public site URL, for example `https://mail.example.com` | Single line |
| `EASYEMAIL_CF_PUBLIC_DOMAIN` | Primary public domain, for example `mail.example.com` | Single line |
| `EASYEMAIL_CF_PASSWORDS` | User login/shared access passwords | Multi-line list |
| `EASYEMAIL_CF_ADMIN_PASSWORDS` | Admin login passwords | Multi-line list |
| `EASYEMAIL_CF_JWT_SECRET` | Worker JWT signing secret | Single line |
| `EASYEMAIL_CF_DOMAINS` | Domain pool used by the worker and routing plan | Multi-line list |
| `EASYEMAIL_CF_SUBDOMAIN_LABEL_POOL` | Random subdomain label pool | Multi-line list |
| `EASYEMAIL_CF_D1_DATABASE_ID` | Existing Cloudflare D1 database ID for update-mode deploys | Single line |
| `EASYEMAIL_CF_API_TOKEN` | Preferred Cloudflare account token for deploy, bootstrap, and routing sync | Single line |
| `EASYEMAIL_CF_AUTH_EMAIL` | Cloudflare global auth email when not using `EASYEMAIL_CF_API_TOKEN` | Single line |
| `EASYEMAIL_CF_GLOBAL_API_KEY` | Cloudflare global API key when not using `EASYEMAIL_CF_API_TOKEN` | Single line |

Use one authentication mode:

- preferred: `EASYEMAIL_CF_API_TOKEN`
- fallback: `EASYEMAIL_CF_AUTH_EMAIL` + `EASYEMAIL_CF_GLOBAL_API_KEY`

## Optional But Common

| Secret name | Purpose | Default if omitted | Format |
| --- | --- | --- | --- |
| `EASYEMAIL_CF_PUBLIC_ZONE` | Explicit owning Cloudflare zone for `publicDomain` | inferred from config or routing plan | Single line |
| `EASYEMAIL_CF_WORKER_NAME` | Worker name override | `cloudflare_temp_email` | Single line |
| `EASYEMAIL_CF_WORKER_ENV` | Wrangler environment override | `production` | Single line |
| `EASYEMAIL_CF_PREFIX` | Worker address prefix | from current config/template | Single line |
| `EASYEMAIL_CF_DEFAULT_DOMAINS` | Default domain list for the worker | falls back to `EASYEMAIL_CF_DOMAINS` | Multi-line list |
| `EASYEMAIL_CF_RANDOM_SUBDOMAIN_DOMAINS` | Domains allowed for random subdomain creation | falls back to `EASYEMAIL_CF_DOMAINS` | Multi-line list |
| `EASYEMAIL_CF_SENDING_DOMAINS` | Optional Cloudflare Email Service sender subdomains that bootstrap should create and add to the worker domain pool | disabled if omitted | Multi-line list |
| `EASYEMAIL_CF_PREFERRED_SENDER_DOMAIN` | Preferred sender domain for EasyEmail-driven Cloudflare mailbox send tests | first sending domain if omitted | Single line |
| `EASYEMAIL_CF_PREFERRED_SENDER_LOCAL_PART` | Preferred static local-part for the reusable sender mailbox, for example `matrixsender` | random sender local-part | Single line |
| `EASYEMAIL_CF_ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH` | Enable subdomain label matching | current config/template | `true` / `false` |
| `EASYEMAIL_CF_RANDOM_SUBDOMAIN_LENGTH` | Generated random subdomain length | current config/template | Integer |
| `EASYEMAIL_CF_ENABLE_USER_CREATE_EMAIL` | Allow users to create addresses | current config/template | `true` / `false` |
| `EASYEMAIL_CF_ENABLE_USER_DELETE_EMAIL` | Allow users to delete addresses | current config/template | `true` / `false` |
| `EASYEMAIL_CF_RESEND_TOKEN` | Optional global Resend token used for outbound mail before falling back to `SEND_MAIL` | disabled if omitted | Single line |
| `EASYEMAIL_CF_SMTP_CONFIG` | Optional YAML/JSON SMTP config object keyed by sender domain | disabled if omitted | Multi-line YAML/JSON |
| `EASYEMAIL_CF_SEND_MAIL_DOMAINS` | Optional allow-list for `SEND_MAIL` binding sender domains | all managed domains | Multi-line list |
| `EASYEMAIL_CF_D1_DATABASE_NAME` | D1 database name override. Use this when mode 1 should auto-create the database. | `cloudflare-temp-email` | Single line |
| `EASYEMAIL_CF_D1_DATABASE_BINDING` | D1 binding override | `DB` | Single line |
| `EASYEMAIL_CF_SYNC_ROUTING` | Enable routing sync during deploy | current config/template | `true` / `false` |
| `EASYEMAIL_CF_ROUTING_MODE` | DNS sync mode | current config/template or workflow input | `exact` / `wildcard` |
| `EASYEMAIL_CF_CONTROL_CENTER_DNS_TOKEN` | Control-center DNS token for DNS sync | disabled if omitted | Single line |
| `EASYEMAIL_CF_BOOTSTRAP_ENABLED` | Enable mode 1 bootstrap behavior from config | `false` | `true` / `false` |
| `EASYEMAIL_CF_BOOTSTRAP_CREATE_ZONES` | Allow bootstrap to create missing Cloudflare zones | `true` | `true` / `false` |
| `EASYEMAIL_CF_BOOTSTRAP_ACCOUNT_ID` | Force a specific Cloudflare account id when multiple accounts are visible | resolved via `wrangler whoami` | Single line |
| `EASYEMAIL_CF_BOOTSTRAP_ZONES` | Explicit zone list for mode 1 bootstrap | inferred from routing plan or `publicZone` | Multi-line list |
| `EASYEMAIL_CF_D1_LOCATION_HINT` | Location hint passed to `wrangler d1 create` | unset | Single line |
| `EASYEMAIL_CF_D1_JURISDICTION` | Jurisdiction passed to `wrangler d1 create` | unset | Single line |
| `EASYEMAIL_CF_BOOTSTRAP_ZONE_TYPE` | Cloudflare zone type passed to bootstrap zone creation | `full` | Single line |
| `EASYEMAIL_CF_BOOTSTRAP_JUMP_START` | Enable Cloudflare zone jump start during bootstrap creation | `false` | `true` / `false` |

## Mode 1: First Deploy

For a true first deploy from an empty EasyEmail state, use the workflow input
`bootstrap_missing_resources=true`.

That mode can:

- create the Cloudflare D1 database if the configured database name does not exist
- create missing Cloudflare zones when `EASYEMAIL_CF_BOOTSTRAP_CREATE_ZONES=true`
- deploy the worker to the public custom domain
- wait for the runtime to come up, then initialize and migrate the D1 schema

Recommended secrets for mode 1:

- `EASYEMAIL_CF_API_TOKEN`
- `EASYEMAIL_CF_PUBLIC_BASE_URL`
- `EASYEMAIL_CF_PUBLIC_DOMAIN`
- `EASYEMAIL_CF_PUBLIC_ZONE`
- `EASYEMAIL_CF_PASSWORDS`
- `EASYEMAIL_CF_ADMIN_PASSWORDS`
- `EASYEMAIL_CF_JWT_SECRET`
- `EASYEMAIL_CF_DOMAINS`
- `EASYEMAIL_CF_SUBDOMAIN_LABEL_POOL`
- `EASYEMAIL_CF_D1_DATABASE_NAME`

If the routing plan does not already make the owning zone obvious, also set
either `EASYEMAIL_CF_PUBLIC_ZONE` or `EASYEMAIL_CF_BOOTSTRAP_ZONES`.

If you want `cloudflare_temp_email` sender mailboxes opened through EasyEmail
to send directly to fresh external mailboxes, configure Cloudflare Email
Service sender subdomains:

- `EASYEMAIL_CF_SENDING_DOMAINS`
- optionally `EASYEMAIL_CF_PREFERRED_SENDER_DOMAIN`
- optionally `EASYEMAIL_CF_PREFERRED_SENDER_LOCAL_PART`

If you instead provide `EASYEMAIL_CF_RESEND_TOKEN`, deploy bootstrap will
create or reuse the Resend sending domain, upsert the required DNS records into
Cloudflare, verify that sending domain, and then let EasyEmail reuse the same
static sender mailbox for sender-matrix runs.

If you prefer a third-party outbound provider instead, you can still use:

- `EASYEMAIL_CF_RESEND_TOKEN`
- `EASYEMAIL_CF_SMTP_CONFIG`

## GHCR Publish Secrets

`.github/workflows/publish-service-base-ghcr.yml` uses these secrets:

| Secret name | Purpose | Format |
| --- | --- | --- |
| `EASYEMAIL_PUBLISH_GHCR_USERNAME` | GHCR login username | Single line |
| `EASYEMAIL_PUBLISH_GHCR_TOKEN` | GHCR push token | Single line |
| `EASYEMAIL_SERVICE_RUNTIME_API_KEY` | `service/base` server bearer token | Single line |
| `EASYEMAIL_PROVIDER_CLOUDFLARE_API_KEY` | `service/base` shared Cloudflare temp email provider key | Single line |
| `EASYEMAIL_PROVIDER_MOEMAIL_API_KEY` | `service/base` MoeMail provider key | Single line |
| `EASYEMAIL_PROVIDER_MOEMAIL_WEB_SESSION_TOKEN` | MoeMail web session token | Single line |
| `EASYEMAIL_PROVIDER_MOEMAIL_WEB_CSRF_TOKEN` | MoeMail web CSRF token | Single line |
| `EASYEMAIL_PROVIDER_IM215_API_KEY` | `service/base` IM215 provider key | Single line |
| `EASYEMAIL_PROVIDER_MAIL2925_ACCOUNT` | `service/base` 2925 account | Single line |
| `EASYEMAIL_PROVIDER_MAIL2925_PASSWORD` | `service/base` 2925 password | Single line |
| `EASYEMAIL_PROVIDER_GPTMAIL_API_KEY` | `service/base` GPTMail provider key | Single line |
| `EASYEMAIL_PROVIDER_GPTMAIL_KEYS_TEXT` | Optional multi-key GPTMail key pool | Multi-line list |
| `EASYEMAIL_PROVIDER_TEMPMAIL_LOL_BASE_URL` | Optional Tempmail.lol base URL override | Single line |
| `EASYEMAIL_PROVIDER_M2U_BASE_URL` | Optional MailToYou base URL override | Single line |
| `EASYEMAIL_PROVIDER_M2U_PREFERRED_DOMAIN` | Optional MailToYou preferred domain | Single line |
| `EASYEMAIL_PROVIDER_M2U_UPSTREAM_PROXY_URL` | Optional dedicated upstream proxy URL for MailToYou fallback | Single line |
| `EASYEMAIL_PROVIDER_M2U_USE_EASY_PROXY_ON_CAPACITY` | Enable MailToYou easy-proxy fallback | `true` / `false` |

If you want the published userscript import bundle to carry the same provider
credentials, also add these repository secrets:

| Secret name | Purpose | Format |
| --- | --- | --- |
| `EASYEMAIL_USERSCRIPT_CLOUDFLARE_CUSTOM_AUTH` | userscript Cloudflare custom auth | Single line |
| `EASYEMAIL_USERSCRIPT_CLOUDFLARE_ADMIN_AUTH` | userscript Cloudflare admin auth | Single line |
| `EASYEMAIL_USERSCRIPT_MOEMAIL_API_KEY` | userscript MoEmail API key | Single line |
| `EASYEMAIL_USERSCRIPT_GPTMAIL_API_KEY` | userscript GPTMail API key | Single line |
| `EASYEMAIL_USERSCRIPT_IM215_API_KEY` | userscript IM215 API key | Single line |
| `EASYEMAIL_USERSCRIPT_MAIL2925_ACCOUNT` | userscript 2925 account email | Single line |
| `EASYEMAIL_USERSCRIPT_MAIL2925_JWT_TOKEN` | userscript 2925 browser JWT token | Single line |
| `EASYEMAIL_USERSCRIPT_MAIL2925_DEVICE_UID` | userscript 2925 browser `deviceUid` | Single line |
| `EASYEMAIL_USERSCRIPT_MAIL2925_COOKIE_HEADER` | userscript 2925 browser cookie header | Single line |

### Private R2 Runtime Config Distribution

`Publish Service Base GHCR` now also renders the final `service/base` runtime
config and uploads it to a private R2 bucket. Add these repository secrets:

| Secret name | Purpose | Format |
| --- | --- | --- |
| `EASYEMAIL_R2_CONFIG_ACCOUNT_ID` | Cloudflare account id that owns the R2 bucket | Single line |
| `EASYEMAIL_R2_CONFIG_BUCKET` | Private R2 bucket name for `service/base` runtime config | Single line |
| `EASYEMAIL_R2_CONFIG_ENDPOINT` | Optional explicit R2 S3 endpoint. Leave empty to derive from account id. | Single line |
| `EASYEMAIL_R2_CONFIG_CONFIG_OBJECT_KEY` | Object key for rendered `config.yaml` | Single line |
| `EASYEMAIL_R2_CONFIG_ENV_OBJECT_KEY` | Object key for rendered `runtime.env` | Single line |
| `EASYEMAIL_R2_CONFIG_USERSCRIPT_OBJECT_KEY` | Object key for remote userscript settings JSON | Single line |
| `EASYEMAIL_R2_CONFIG_MANIFEST_OBJECT_KEY` | Object key for the unified EasyEmail distribution manifest | Single line |
| `EASYEMAIL_R2_CONFIG_UPLOAD_ACCESS_KEY_ID` | R2 upload access key id used by GitHub Actions | Single line |
| `EASYEMAIL_R2_CONFIG_UPLOAD_SECRET_ACCESS_KEY` | R2 upload secret access key used by GitHub Actions | Single line |

Optional repository-only admin storage for the client bootstrap key pair:

| Secret name | Purpose | Format |
| --- | --- | --- |
| `EASYEMAIL_R2_CONFIG_READ_ACCESS_KEY_ID` | Client-side R2 read-only access key id | Single line |
| `EASYEMAIL_R2_CONFIG_READ_SECRET_ACCESS_KEY` | Client-side R2 read-only secret access key | Single line |
| `EASYEMAIL_IMPORT_CODE_OWNER_PUBLIC_KEY` | Owner-only import-code encryption public key. GitHub Actions uses it to emit only an encrypted import-code artifact; keep the matching private key local. | Single line |

### Encrypted Import Code Output

`Publish Service Base GHCR` now uploads four private R2 artifacts together:

- rendered `service/base` `config.yaml`
- rendered `service/base` `runtime.env`
- remote userscript settings JSON
- unified distribution manifest

After that upload finishes, the workflow also generates an EasyEmail import
code and immediately encrypts it with `EASYEMAIL_IMPORT_CODE_OWNER_PUBLIC_KEY`.

The workflow publishes only the encrypted JSON artifact:

- `service-base-import-code-encrypted`

To recover the plain import code locally, keep the matching private key on the
trusted operator machine and run:

```powershell
pwsh .\scripts\decrypt-import-code.ps1 `
  -EncryptedFilePath .\service-base-import-code.encrypted.json `
  -PrivateKeyPath C:\path\to\easyemail_import_code_owner_private.txt `
  -ImportCodeOnly
```

## Local Operator Config

For local scripts, the repository root `config.yaml` remains the single source
of operator secrets for:

- `userscript.secrets`
- `serviceBase.runtime`
- `cloudflareMail.worker.vars`
- `cloudflareMail.routing.*`
- `publishing.*`

Keep that file local and do not commit it.

## Slim Sender-Matrix Acceptance

`.github/workflows/deploy-cloudflare-email.yml` now has an optional
post-deploy sender-matrix acceptance step.

It runs by default for tag-triggered deploys and for manual runs unless
`run_sender_matrix=false`.

Besides the `EASYEMAIL_CF_*` deploy secrets, that acceptance step also needs
the `service/base` provider secrets because it starts a local verifier
container and opens real recipient mailboxes. In practice that means the
workflow needs:

- `EASYEMAIL_SERVICE_RUNTIME_API_KEY`
- `EASYEMAIL_PROVIDER_CLOUDFLARE_API_KEY`
- `EASYEMAIL_PROVIDER_MOEMAIL_API_KEY`
- `EASYEMAIL_PROVIDER_MOEMAIL_WEB_SESSION_TOKEN`
- `EASYEMAIL_PROVIDER_MOEMAIL_WEB_CSRF_TOKEN`
- `EASYEMAIL_PROVIDER_IM215_API_KEY`
- `EASYEMAIL_PROVIDER_MAIL2925_ACCOUNT`
- `EASYEMAIL_PROVIDER_MAIL2925_PASSWORD`
- `EASYEMAIL_PROVIDER_GPTMAIL_API_KEY`
- `EASYEMAIL_PROVIDER_GPTMAIL_KEYS_TEXT`
- `EASYEMAIL_PROVIDER_TEMPMAIL_LOL_BASE_URL`
- `EASYEMAIL_PROVIDER_M2U_BASE_URL`
- `EASYEMAIL_PROVIDER_M2U_PREFERRED_DOMAIN`
- `EASYEMAIL_PROVIDER_M2U_UPSTREAM_PROXY_URL`
- `EASYEMAIL_PROVIDER_M2U_USE_EASY_PROXY_ON_CAPACITY`
