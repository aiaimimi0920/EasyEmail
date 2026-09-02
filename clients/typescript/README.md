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

const contact = await client.createContact({
  displayName: "Ada Lovelace",
  emailAddress: "ada@example.com",
});
await client.updateContact(contact.id, {
  expectedVersion: contact.version,
  note: "Project contact",
});

const account = await client.createMailAccount({
  kind: "normal_long_lived",
  displayName: "Work Mail",
  primaryAddress: "work@example.com",
  imap: {
    host: "imap.example.com",
    port: 993,
    security: "tls",
    username: "work@example.com",
  },
  credentialRefs: [{
    secretBackend: "windows_credential_manager",
    secretKey: "ref:v1:account/work-imap",
    credentialKind: "imap_password",
    authMethod: "password",
  }],
});
await client.testMailAccountImap({
  accountId: account.id,
  credentialRefId: account.credentialRefs[0].id,
});
await client.disableMailAccount(account.id, account.version);
```

Account requests accept only opaque `ref:v1:...` credential references, never
passwords or tokens. `testMailAccountImap` sends only account/reference IDs; it
never accepts the secret. Resolution and network testing remain trusted
server/desktop runtime responsibilities. A runtime without a configured resolver
or IMAP tester fails closed with HTTP 503.

The API key is a runtime input. Do not write it into source files, package
metadata, browser bundles, or release artifacts.

The package targets the HTTP routes exposed by the EasyEmail `service/base`
server in the same repository release. It is retained for compatibility and
convenience, not as a required dependency for new integrations or the future
bundled UI.
