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

## Persistent contacts

Contacts are stored by the local server in its separate relational SQLite
database. They are not held in UI memory and are not written to the legacy
EasyEmailAM database.

```http
POST /mail/contacts
Authorization: Bearer <easyemail-api-key>
Content-Type: application/json

{
  "displayName": "Ada Lovelace",
  "emailAddress": "ada@example.com",
  "note": "Project contact"
}
```

Create is an idempotent upsert by normalized email address and returns
`{ "contact": ... }`. `GET /mail/contacts?limit=50&cursor=<opaque>` uses stable
case-insensitive name/email ordering. Pass `nextCursor` back unchanged.

`PATCH /mail/contacts/{contactId}` and
`DELETE /mail/contacts/{contactId}?expectedVersion=N` use the returned positive
`version` as compare-and-swap protection. Delete is hard and does not mutate
messages. A stale version or email collision returns 409.

## Persistent account metadata

Account metadata is stored in schema v4 of `easy-email-relational.sqlite3`.
`GET /mail/accounts?scope=normal&limit=50&cursor=<opaque>` preserves the legacy
normal-account view: it includes normal accounts plus the system-managed
`acct_anonymous_virtual` account, while Agent accounts remain isolated. Cursors
are bound to the requested scope and must be returned unchanged.

Create normal long-lived or Agent-owned metadata with `POST /mail/accounts`.
The current request accepts only `normal_long_lived` and `agent_owned`; promoted
temporary accounts are created only by the later promotion workflow, and callers
cannot create, update, disable, or delete the anonymous virtual account. Both
creatable kinds require `primaryAddress`.

```http
POST /mail/accounts
Authorization: Bearer <easyemail-api-key>
Content-Type: application/json

{
  "kind": "normal_long_lived",
  "displayName": "Work Mail",
  "primaryAddress": "work@example.com",
  "imap": {
    "host": "imap.example.com",
    "port": 993,
    "security": "tls",
    "username": "work@example.com"
  },
  "credentialRefs": [{
    "secretBackend": "windows_credential_manager",
    "secretKey": "ref:v1:account/work-imap",
    "credentialKind": "imap_password",
    "authMethod": "password"
  }]
}
```

`credentialRefs` contain metadata only. A new write must use an opaque
`ref:v1:...` key; raw passwords, tokens, authorization codes, and secret blobs
are rejected. `imap` stores only non-secret connection metadata. `security:
"ssl"` is accepted on input and canonicalized to `"tls"`.

Test a stored profile and account-owned reference with `POST
/mail/accounts/imap/test` and body `{ "accountId": "...", "credentialRefId":
"..." }`. This request also rejects all raw-secret fields. A missing or invalid
reference returns a machine-readable 409 reauthentication error, rejected remote
credentials return 422, and an unavailable resolver, tester, or remote IMAP
service returns 503. In bundled desktop mode, Tauri supplies the exact Node child
with a separately authenticated `127.0.0.1` credential broker. The broker first
reads the canonical account through this HTTP API and requires the requested ref
to match its account owner, backend, key, kind, and authentication method before
loading Windows Credential Manager. The production tester uses ImapFlow with TLS
or forced STARTTLS, TLS 1.2 minimum, protocol logging disabled, and bounded
connection and cleanup time. A standalone CLI runtime with no configured
server-side account resolver still returns 503 rather than using an unsafe
fallback. The React account screen has not yet switched to this route.

Read with `GET /mail/accounts/{accountId}`. Metadata updates use
`PATCH /mail/accounts/{accountId}` with `expectedVersion`; disable uses
`POST /mail/accounts/{accountId}/disable` with `{ "expectedVersion": N }`;
soft-delete uses `DELETE /mail/accounts/{accountId}?expectedVersion=N`. Address,
credential-ref ownership, stale-version, or system-managed-account conflicts
return 409.

## Persistent mail taxonomy

Folders and labels are stored in schema v2 of the same separate relational
SQLite database. List one kind at a time with
`GET /mail/taxonomy?kind=folder|label&limit=50&cursor=<opaque>`.

Create or idempotently update an item by normalized name with:

```http
PUT /mail/taxonomy/folder/project_alpha
Authorization: Bearer <easyemail-api-key>
Content-Type: application/json

{
  "name": "Project Alpha",
  "parentId": null,
  "color": "#8b5cf6"
}
```

The path `key` is the legacy-compatible name slug: ASCII letters and digits are
lowercased and retained, every other character becomes `_`, edge underscores
are removed, and an empty result becomes `item`. Names contain 1 to 64
characters after whitespace normalization. Labels reject `parentId`; folders
require an existing folder parent and reject cycles. Invalid colors normalize
to `#8b5cf6`.

Read an item with `GET /mail/taxonomy/{itemId}`. Update with
`PATCH /mail/taxonomy/{itemId}` using the full `name`, optional `parentId` and
`color`, plus the returned `expectedVersion`. Delete with
`DELETE /mail/taxonomy/{itemId}?expectedVersion=N`. Delete is hard for
non-system items and reparents direct children to the root; a protected system
item returns `changed: false`.

Every taxonomy response includes:

```json
{
  "capabilities": {
    "messageReferencePropagation": false
  }
}
```

This is a deliberate capability boundary: schema v2 owns taxonomy records, but
the current `service/base` message model does not yet own the legacy desktop
message folder/label references. Taxonomy rename/delete therefore does not
rewrite message records. The desktop UI continues to use its legacy
transactional taxonomy command until the M4 message model can provide equivalent
propagation; HTTP callers must not interpret taxonomy mutations as message
mutations.

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
| `GET` | `/mail/contacts` | List persistent contacts with opaque keyset pagination. |
| `POST` | `/mail/contacts` | Create or upsert a contact by normalized email. |
| `GET` | `/mail/contacts/{contactId}` | Read one contact. |
| `PATCH` | `/mail/contacts/{contactId}` | Update one contact with version CAS. |
| `DELETE` | `/mail/contacts/{contactId}?expectedVersion=N` | Hard-delete one contact with version CAS. |
| `GET` | `/mail/accounts?scope=normal\|agent\|system` | List persistent account metadata with scope-bound keyset pagination. |
| `POST` | `/mail/accounts` | Create normal long-lived or Agent-owned account metadata. |
| `GET` | `/mail/accounts/{accountId}` | Read one account. |
| `PATCH` | `/mail/accounts/{accountId}` | Update account metadata with version CAS. |
| `POST` | `/mail/accounts/{accountId}/disable` | Disable receive/send state with version CAS. |
| `DELETE` | `/mail/accounts/{accountId}?expectedVersion=N` | Soft-delete one account with version CAS. |
| `POST` | `/mail/accounts/imap/test` | Test a stored IMAP profile using an account-owned opaque credential reference. |
| `GET` | `/mail/taxonomy?kind=folder\|label` | List persistent folders or labels with opaque keyset pagination. |
| `PUT` | `/mail/taxonomy/{kind}/{key}` | Create or upsert a folder or label by normalized name. |
| `GET` | `/mail/taxonomy/{itemId}` | Read one folder or label. |
| `PATCH` | `/mail/taxonomy/{itemId}` | Update one folder or label with version CAS. |
| `DELETE` | `/mail/taxonomy/{itemId}?expectedVersion=N` | Delete a non-system folder or label with version CAS. |

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
| `409` | A unique constraint or version compare-and-swap conflict occurred. |
| `500` | An EasyEmail, provider, persistence, or unexpected runtime error occurred. |
| `503` | A required persistent relational capability is disabled or unavailable. |

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
