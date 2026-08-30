# EasyEmail TypeScript Client

This package is a typed HTTP client for a locally hosted EasyEmail server. It
does not embed provider credentials and does not include the EasyEmail server
runtime.

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

The first package version targets the public HTTP routes exposed by the
EasyEmail `service/base` server in the same repository release.
