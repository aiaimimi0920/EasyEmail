# Exact custom addresses for trusted services

The migration branch adds constrained endpoints without replacing `/admin/new_address`. This contract does not imply a production upgrade.

## Authentication and capability

`GET /admin/custom_address_capability` requires `x-admin-auth` matching a configured `ADMIN_PASSWORDS` entry,
plus the optional global `x-custom-auth` required by the instance. The handler requires a real admin key even when
legacy admin-password bypass is enabled or an admin role token is present. Responses use `Cache-Control: no-store`:

```json
{"contract":"easyemail-custom-address-v1","enabled":true,"minLength":1,"maxLength":30,"domains":["mail.example.com"]}
```

Disabling `ENABLE_USER_CREATE_EMAIL` or enabling `DISABLE_CUSTOM_ADDRESS_NAME` returns `enabled=false`.
Invalid configuration or unavailable blacklist storage returns a sanitized 503 instead of a relaxed policy.

## Creation

`POST /admin/custom_address`, with `Content-Type: application/json` and an actual streamed-body limit of 8 KiB:

```json
{"name":"chosen123","domain":"mail.example.com"}
```

Only these fields are accepted. Names contain 1–30 lowercase ASCII letters or digits and must satisfy configured
length limits, unchanged normalization under `ADDRESS_REGEX`, `ADDRESS_CHECK_REGEX` and the name blacklist.
No trimming, case conversion, system/role prefix or random subdomain is applied. Domains are concrete members
of `DOMAINS` intersected with nonempty `DEFAULT_DOMAINS`; empty defaults fall back to `DOMAINS`.
This contract does not expand wildcard templates or allow arbitrary subdomain matching.

HTTP 201 returns the production creator's `address`, `address_id`, `jwt` and optional password. Existing addresses
never yield an existing credential. Invalid input returns 400, missing authentication 401, disabled capability 403,
oversized bodies 413 and unsupported media types 415. Policy/storage failures return 503. A response or signing
failure may happen after INSERT: callers must preserve the original address and durable idempotency guard,
not blindly retry or switch addresses.

This is a trusted-service proxy, not the anonymous creation route. The aggregator owns authenticated users,
quotas and rate limits; anonymous-user, Turnstile, upstream role and per-upstream-user mailbox gates do not apply.
Existing global-access middleware still applies. If the upstream lacks this capability endpoint, reject custom
creation rather than falling back to the legacy privileged admin creator.
