# EasyEmail HTTP API

`service/base` exposes EasyEmail as an authenticated HTTP service. Any program
that can send HTTP requests can use it directly; installing or publishing an
EasyEmail SDK is not required.

The machine-readable, authoritative API description is
[`easyemail-openapi.json`](./easyemail-openapi.json). The TypeScript package in
`clients/typescript` is an optional compatibility helper, not the API contract.

## Connection model

The default host deployment publishes the service at:

```text
http://127.0.0.1:18081
```

Callers may instead use a LAN or remote URL when the operator deliberately
exposes the server, for example `http://192.0.2.10:18081` or an HTTPS reverse
proxy. The request paths and JSON payloads do not change with the deployment
location.

Set `serviceBase.runtime.server.apiKey` in the root `config.yaml`. Send the value
as a Bearer token on every request:

```http
Authorization: Bearer <easyemail-api-key>
Content-Type: application/json
```

The runtime currently allows authentication to be disabled by leaving the API
key empty. That mode is only suitable for isolated development. A LAN, remote,
or bundled-UI deployment must use an API key.

## Create a temporary mailbox

The smallest mailbox-open request contains `hostId`, `provisionMode`, and
`bindingMode`.

### PowerShell

```powershell
$baseUrl = "http://127.0.0.1:18081"
$headers = @{ Authorization = "Bearer $env:EASY_EMAIL_API_KEY" }
$body = @{
  hostId = "registration-worker"
  provisionMode = "auto-create-if-missing"
  bindingMode = "shared-instance"
} | ConvertTo-Json

$mailbox = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/mail/mailboxes/open" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body

$mailbox.result.session
```

### curl

```powershell
curl.exe --fail-with-body `
  -X POST "http://127.0.0.1:18081/mail/mailboxes/open" `
  -H "Authorization: Bearer $env:EASY_EMAIL_API_KEY" `
  -H "Content-Type: application/json" `
  --data '{"hostId":"registration-worker","provisionMode":"auto-create-if-missing","bindingMode":"shared-instance"}'
```

### JavaScript

```js
const response = await fetch("http://127.0.0.1:18081/mail/mailboxes/open", {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.EASY_EMAIL_API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    hostId: "registration-worker",
    provisionMode: "auto-create-if-missing",
    bindingMode: "shared-instance",
  }),
});

if (!response.ok) {
  throw new Error(`EasyEmail returned HTTP ${response.status}: ${await response.text()}`);
}

const mailbox = await response.json();
console.log(mailbox.result.session);
```

### Python standard library

```python
import json
import os
from urllib.request import Request, urlopen

request = Request(
    "http://127.0.0.1:18081/mail/mailboxes/open",
    method="POST",
    headers={
        "Authorization": f"Bearer {os.environ['EASY_EMAIL_API_KEY']}",
        "Content-Type": "application/json",
    },
    data=json.dumps(
        {
            "hostId": "registration-worker",
            "provisionMode": "auto-create-if-missing",
            "bindingMode": "shared-instance",
        }
    ).encode("utf-8"),
)

with urlopen(request) as response:
    mailbox = json.load(response)

print(mailbox["result"]["session"])
```

A successful mailbox-open response contains the session under `result.session`.
The following is a shortened shape; the OpenAPI schema also documents the
selected provider, binding, temporary access, and recovery metadata:

```json
{
  "result": {
    "session": {
      "id": "mailbox_...",
      "hostId": "registration-worker",
      "providerTypeKey": "cloudflare_temp_email",
      "providerInstanceId": "cloudflare_temp_email-default",
      "emailAddress": "example@example.test",
      "mailboxRef": "...",
      "status": "open",
      "createdAt": "2026-08-31T00:00:00.000Z",
      "metadata": {}
    }
  }
}
```

## Common mailbox flow

1. `POST /mail/mailboxes/plan` optionally previews provider selection.
2. `POST /mail/mailboxes/open` creates or reuses a mailbox and returns its
   session identifier.
3. `GET /mail/mailboxes/{sessionId}/code` synchronizes the inbox and returns a
   verification code when one is available.
4. `GET /mail/mailboxes/{sessionId}/auth-link` performs the equivalent lookup
   for an authentication link.
5. `POST /mail/mailboxes/send` sends mail when the selected provider supports
   outbound delivery.
6. `POST /mail/mailboxes/release` releases the session when the caller is done.

Named request schemas, optional filters, enums, and the core mailbox response
envelopes are defined in the OpenAPI document. Some large administrative and
catalog payloads intentionally remain permissive JSON objects until their domain
models are promoted to stable public response schemas.

## Endpoint inventory

All current routes require the same Bearer token when authentication is enabled.
The grouping below describes intended responsibility; it is not a separate
authorization tier.

### Mailbox and application operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/mail/catalog` | Read the provider and strategy catalog. |
| `GET` | `/mail/snapshot` | Read the current service snapshot. |
| `POST` | `/mail/mailboxes/plan` | Plan provider selection without opening a mailbox. |
| `POST` | `/mail/mailboxes/open` | Open, reuse, or create a temporary mailbox. |
| `POST` | `/mail/mailboxes/send` | Send a message from an opened mailbox. |
| `POST` | `/mail/mailboxes/update-session` | Update session filters or metadata. |
| `POST` | `/mail/mailboxes/release` | Release an opened mailbox session. |
| `POST` | `/mail/mailboxes/recover-by-email` | Recover a mailbox from address and recovery data. |
| `POST` | `/mail/mailboxes/recover-capacity` | Run provider-specific capacity recovery. |
| `POST` | `/mail/providers/moemail/cleanup` | Clean stale MoEmail mailboxes. |
| `POST` | `/mail/mailboxes/report-outcome` | Report a business outcome for a mailbox session. |
| `POST` | `/mail/messages/observe` | Persist a message observed by an external caller. |
| `GET` | `/mail/mailboxes/{sessionId}/code` | Synchronize a mailbox and read its verification code. |
| `GET` | `/mail/mailboxes/{sessionId}/auth-link` | Synchronize a mailbox and read its authentication link. |

### Provider administration and queries

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/mail/providers/cloudflare_temp_email/register` | Register a Cloudflare Temp Email runtime. |
| `POST` | `/mail/providers/credentials/apply` | Apply credential sets to a provider instance. |
| `GET` | `/mail/providers/probe-all` | Probe all configured provider instances. |
| `GET` | `/mail/providers/{instanceId}/probe` | Probe one provider instance. |
| `GET` | `/mail/query/provider-instances` | Query provider instances. |
| `GET` | `/mail/query/host-bindings` | Query host-to-provider bindings. |
| `GET` | `/mail/query/mailbox-sessions` | Query mailbox sessions. |
| `GET` | `/mail/query/observed-messages` | Query and optionally synchronize observed messages. |
| `GET` | `/mail/query/observed-messages/{messageId}` | Read one observed message. |
| `GET` | `/mail/query/stats` | Read persistence statistics. |

### Maintenance

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/mail/maintenance/run` | Run expiry, cleanup, and provider refresh immediately. |

## HTTP status and error body

Current status behavior is:

| Status | Meaning |
| --- | --- |
| `200` | The route completed. Inspect optional result fields for a not-yet-available code or message. |
| `400` | Invalid JSON or an invalid query value. |
| `401` | The configured Bearer token is missing or incorrect. |
| `404` | No route matches the method and path. |
| `500` | An EasyEmail, provider, persistence, or unexpected runtime error occurred. |

EasyEmail errors normally include `code`, `error`, and `message`. Callers must
not assume that every `500` is permanent; provider-specific error codes can
represent transient upstream failures.

## Deployment and security

- Keep the service bound to loopback for same-machine callers whenever possible.
- For LAN or remote access, require a non-empty API key and place the service
  behind an HTTPS reverse proxy or an equivalently protected private network.
- Do not place API keys in URLs, source files, release artifacts, or logs.
- Treat administrative routes as operator capabilities even though the current
  server uses one Bearer-token authorization tier.
- The future bundled UI must generate or provision a private token and call the
  packaged server over authenticated loopback HTTP.

## Product boundaries

- Standalone programs call this HTTP API directly. They do not need the
  TypeScript compatibility helper.
- The bundled UI uses the same `service/base` HTTP API, but its host process also
  owns automatic server startup and shutdown. See
  [`ui-bundled-runtime.md`](./ui-bundled-runtime.md).
- The Userscript does **not** call this API. It is a separate browser runtime
  that directly implements provider access and only aligns on provider names,
  upstream endpoints, and ports.
