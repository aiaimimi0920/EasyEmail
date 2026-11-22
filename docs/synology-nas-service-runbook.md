# Synology NAS Service Runbook

This runbook records the LAN deployment of the EasyEmail `service/base` HTTP
SDK on the Synology NAS at `192.168.15.200`.

## Current deployment

The current 2026-10-28 verified sixteen-file incremental deployment is documented
in [operations-production-send-safety-20261028.md](./operations-production-send-safety-20261028.md).
It preserves the existing send modes and snapshot implementation. The active
image ID is `sha256:d2ee8e3ecdbe0fed97e9efb2862fc4128f3c0560ead70c0bd732bba141c8f5d2`.
Read its backup, data-verification, and retained-container boundaries before
operating. Earlier deployment history remains in [operations-20261025.md](./operations-20261025.md).
Do not use Compose orphan cleanup: retained rollback containers carry Compose labels.

## Original deployment (2026-09-07, superseded)

- base URL: `http://192.168.15.200:18081`
- compose project: `easyemail-sdk`
- container: `easyemail-sdk`
- image: `easyemail/easy-email-service:nas-20260907-002`
- image ID: `sha256:9ac542fb19fc3dcd3ee442385dfd71db3d7d5f82a6c88465ea7ae9a8a18a2c19`
- Docker network: `EasyAiMi`
- in-network alias: `easy-email-service`
- restart policy: `unless-stopped`
- host bind: `192.168.15.200:18081`, not every NAS interface

The NAS uses DSM 7.2 and does not expose the CPU CFS control needed by
Compose's `cpus` field. The deployed Compose copy therefore omits the CPU quota
while retaining the 768 MiB memory limit, 1536 MiB memory-plus-swap limit, log
rotation, persistent mounts, and temporary-filesystem limit.

## Persistent paths

All instance-owned files are below:

```text
/volume1/docker/easyemail-sdk
```

Important paths:

```text
/volume1/docker/easyemail-sdk/config/config.yaml
/volume1/docker/easyemail-sdk/config/runtime.env
/volume1/docker/easyemail-sdk/data
/volume1/docker/easyemail-sdk/deploy/docker-compose.yaml
/volume1/docker/easyemail-sdk/deploy/service.env
/volume1/docker/easyemail-sdk/operator/api-token
/volume1/docker/easyemail-sdk/operator/deployment-manifest.env
```

The config, runtime environment, token, and deployment manifest are restricted
files. Do not copy them into Git, chat, tickets, or general-purpose logs.

## Authentication

Every API request requires:

```http
Authorization: Bearer <API_TOKEN>
```

An unauthenticated request must return HTTP 401. An operator can retrieve the
token deliberately over SSH without reading the provider configuration:

```bash
ssh mjc@192.168.15.200 \
  "sudo cat /volume1/docker/easyemail-sdk/operator/api-token"
```

Keep the returned value in memory or a protected secret store. Do not save it
in source-controlled client configuration.

## Readiness

The service does not currently expose `/health` or `/healthz`. Use the
authenticated catalog route:

```powershell
$baseUrl = 'http://192.168.15.200:18081'
$token = Read-Host 'EasyEmail API token'
$headers = @{ Authorization = "Bearer $token" }

Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUrl/mail/catalog" `
  -Headers $headers
```

Readiness requires a successful HTTP response containing a `catalog` object.

## Create a mailbox

Specify `cloudflare_temp_email` when the caller needs the fully validated
create, receive, read, code-extraction, and upstream-release lifecycle:

```powershell
$openBody = @{
  hostId = 'lan-client-01'
  providerTypeKey = 'cloudflare_temp_email'
  provisionMode = 'reuse-only'
  bindingMode = 'shared-instance'
  ttlMinutes = 30
} | ConvertTo-Json

$open = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/mail/mailboxes/open" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $openBody

$sessionId = $open.result.session.id
$emailAddress = $open.result.session.emailAddress
```

Omitting `providerTypeKey` enables server-owned `available-first` routing. That
can select a provider such as `tempmail-lol` that expires the local session but
does not support immediate upstream deletion. Callers that require deterministic
release semantics should name `cloudflare_temp_email` explicitly.

## Refresh and read messages

```powershell
$escapedSessionId = [Uri]::EscapeDataString($sessionId)

Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/mail/mailboxes/$escapedSessionId/refresh" `
  -Headers $headers

$messages = Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUrl/mail/query/observed-messages?sessionId=$escapedSessionId&limit=50&newestFirst=true" `
  -Headers $headers
```

Read one complete message:

```powershell
$messageId = [Uri]::EscapeDataString($messages.messages[0].id)

Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUrl/mail/query/observed-messages/$messageId" `
  -Headers $headers
```

Read the latest extracted verification code or authentication link:

```powershell
Invoke-RestMethod -Method Get `
  -Uri "$baseUrl/mail/mailboxes/$escapedSessionId/code" `
  -Headers $headers

Invoke-RestMethod -Method Get `
  -Uri "$baseUrl/mail/mailboxes/$escapedSessionId/auth-link" `
  -Headers $headers
```

## Release a mailbox

```powershell
$releaseBody = @{
  sessionId = $sessionId
  reason = 'lan-client-complete'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/mail/mailboxes/release" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $releaseBody
```

The session status becomes `expired`. The `released` field indicates whether
the selected provider also supports immediate upstream deletion.

## Operations

Run these commands over SSH on the NAS. They preserve the persistent data
directory:

```bash
ROOT=/volume1/docker/easyemail-sdk
COMPOSE=/usr/local/bin/docker-compose

# Inspect status and logs.
sudo /usr/local/bin/docker ps --filter name=easyemail-sdk
sudo /usr/local/bin/docker logs --tail 200 easyemail-sdk

# Reconcile or start the pinned deployment.
sudo "$COMPOSE" \
  --env-file "$ROOT/deploy/service.env" \
  -p easyemail-sdk \
  -f "$ROOT/deploy/docker-compose.yaml" \
  up -d --no-build

# Restart without changing configuration.
sudo /usr/local/bin/docker restart easyemail-sdk

# Stop without deleting state.
sudo "$COMPOSE" \
  --env-file "$ROOT/deploy/service.env" \
  -p easyemail-sdk \
  -f "$ROOT/deploy/docker-compose.yaml" \
  stop
```

Do not run `down -v`, do not delete the data directory during an update, and
do not set `EASY_EMAIL_RESET_STORE_ON_BOOT=true` on this persistent instance.

## End-to-end validation

The reusable validation script creates two controlled mailboxes, sends a
message containing a random marker and verification code, refreshes the
recipient, validates list/detail/code reads, and releases both mailboxes even
when the main assertion fails:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\test-nas-service-lifecycle.ps1 `
  -BaseUrl 'http://192.168.15.200:18081' `
  -ApiTokenPath '<PROTECTED_TOKEN_FILE>' `
  -ConfigPath .\config.yaml `
  -ConfirmExternalSideEffects
```

The JSON result reports local closure (`RecipientSessionClosed` and
`SenderSessionClosed`) separately from provider-side deletion
(`RecipientUpstreamReleased` and `SenderUpstreamReleased`). Cleanup requests
are retried once; an unconfirmed cleanup makes the script fail without printing
the bearer token.

The deployment was also validated across a container restart: the same open
mailbox session remained queryable, could be released after restart, and the
resulting `expired` state survived a subsequent Compose recreation.

## Security boundary

- The service listens only on the NAS LAN address.
- Bearer authentication is mandatory for every route.
- The entrypoint runs as root to prepare mounted-directory ownership, then
  starts the main application as UID 10001. The main Node UID was verified via
  host `/proc`; an empty container `Config.User` or root `docker exec` helper
  does not identify the application UID. This update does not change that model.
- Provider secrets stay in restricted config/runtime files.
- JSON logs rotate at 20 MiB with five retained files.
- The current LAN endpoint is plain HTTP. Put the service behind a trusted TLS
  reverse proxy before crossing untrusted Wi-Fi, routed VLANs, VPN peers, or
  the public internet.
- Browser applications also need explicit `corsOrigins`; command-line and
  backend HTTP clients do not.
