# Real-provider lifecycle validation

This document records the controlled M1 acceptance path for the deployed
`cloudflare_temp_email` provider. It is an operator-only validation, not a
default CI test: it creates two real upstream mailboxes, sends one message, and
deletes both mailboxes again.

## Run it

The repository root `config.yaml` must provide all of the following:

- the Local Server API key;
- the deployed Cloudflare Temp Email base URL and provider API key;
- the deployed provider domain configuration;
- a Resend token and verified preferred sender domain;
- `ENABLE_USER_DELETE_EMAIL=true` in the Worker variables;
- enabled Local Server persistence.

Run from the repository root:

```powershell
pwsh .\scripts\test-real-provider-lifecycle.ps1 `
  -ConfirmExternalSideEffects `
  -ConfigPath .\config.yaml `
  -Rebuild
```

`-ConfirmExternalSideEffects` is mandatory. Omitting it fails before reading
configuration or invoking Docker. `-ResultOutputPath` may be used to retain the
secret-free JSON result for a controlled evidence job.

## What the gate proves

The script performs this sequence against one isolated `service/base` runtime:

1. allocate a random loopback port and refuse port `18081` explicitly;
2. create unique container, network, image, runtime, and host identifiers;
3. start the Local Server and require an authenticated catalog plus a successful
   active Cloudflare provider probe;
4. read back the provider-reported default domain metadata;
5. create an anonymous recipient mailbox and a sender mailbox on the configured
   preferred sender domain;
6. send a unique marker and six-digit verification code through the mailbox API;
7. verify the delivered subject, body, and extracted code through Local Server
   HTTP resources;
8. call the Local Server release resource for both sessions and require the
   provider's authenticated `DELETE /api/delete_address` response to report
   `success=true`;
9. wait until the released session and observed message reach the isolated
   persistent snapshot, restart the exact isolated container, and verify both
   records are restored;
10. scan the launch and container logs for every non-empty secret-bearing
    configuration value, then remove only the resources owned by the run.

An uncertain mailbox-open response is reconciled by the run-unique `hostId` and
provider instance. Any open session discovered by that reconciliation is
released before Docker cleanup, so a timeout or malformed response cannot make
the test silently abandon an upstream mailbox.

## Recorded M1 evidence (2026-09-01)

The production Worker was first validated by the deploy script's dry-run path
and then deployed successfully. The deployed Worker version was:

```text
615b83f8-1c1a-448d-b494-0993284cf5c6
```

The controlled lifecycle completed with these secret-free semantic results:

- authenticated catalog and active provider probe: passed;
- provider-reported domains available: true;
- configured sender domain selected: true;
- recipient and sender mailbox creation: passed;
- delivery mode: `admin_delegate`;
- verification code and observed body: matched;
- recipient and sender upstream deletion: confirmed;
- local release state: `released`, detail `deleted`;
- restart readback of the session and message: passed;
- launch/container credential scan: passed;
- existing service on port `18081` touched: false.

No credential value, mailbox address, message marker, or provider JWT belongs in
committed evidence. Store only the semantic booleans and stable deployment
version shown above.

## Safety and current limitation

- Cleanup targets exact run-owned names and verifies that runtime-directory
  deletion remains below `.tmp/service-base-real`.
- A failure after a mailbox has been captured triggers another release attempt;
  an uncertain open is queried by its unique `hostId` for up to 30 seconds and
  released if present.
- The provider delete endpoint performs the actual upstream deletion. The test
  fails closed when deletion is disabled, rejected, or not explicitly confirmed.
- M9 graceful shutdown has not been implemented yet. Therefore this M1 gate
  waits for the periodic persistent snapshot before restarting the isolated
  container; it does not treat an immediate hard restart as a persistence
  guarantee.
- Upstream deletion is currently implemented by the deployed Worker rather than
  as one transactional multi-statement operation. A non-confirmed result remains
  a blocking failure and requires operator investigation.
