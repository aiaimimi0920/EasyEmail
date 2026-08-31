# EasyEmail TypeScript Client

This package is an optional typed compatibility helper for the HTTP API exposed
by an EasyEmail Local Server. Programs do not need this package: any HTTP client
may use the authoritative
[`docs/easyemail-openapi.json`](../../docs/easyemail-openapi.json) contract and
[`docs/http-api.md`](../../docs/http-api.md) directly.

The package does not own the API contract, embed provider credentials, or
include the EasyEmail server runtime. It also does not start or manage a local
server process.

```ts
import { EasyEmailClient } from "easy-email-client";

const client = new EasyEmailClient({
  baseUrl: "http://127.0.0.1:18081",
  apiKey: process.env.EASY_EMAIL_API_KEY,
});

const mailbox = await client.openMailbox({
  hostId: "registration-worker",
  provisionMode: "reuse-only",
  bindingMode: "shared-instance",
});

const code = await client.readVerificationCode(mailbox.session.id);
```

The API key is a runtime input. Do not write it into source files, package
metadata, browser bundles, or release artifacts.

The package targets the HTTP routes exposed by the EasyEmail `service/base`
server in the same repository release. It is retained for compatibility and
convenience, not as a required dependency for new integrations or the future
bundled UI.
