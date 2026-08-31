# Client and Userscript Distribution

EasyEmail currently publishes an optional TypeScript HTTP helper and a
secret-free Userscript through
`.github/workflows/publish-client-userscript.yml`. They share a distribution
workflow for release compatibility, not a runtime implementation or dependency.

The authoritative Local Server interface is the HTTP/OpenAPI documentation in
[`http-api.md`](./http-api.md) and
[`easyemail-openapi.json`](./easyemail-openapi.json). A published SDK is not
required.

## Migration from the private server consumer

The former `service/base/src/consumer` HTTP client and
`service/base/src/neuroplugin-consumer.ts` compatibility entrypoint have been
removed intentionally. `service/base` owns the server, not an SDK distribution
boundary. Code that imported `HttpVerificationInboxClient`,
`VerificationInboxClient`, or `createFetchJsonHttpClient` from server-internal
paths must migrate to the documented HTTP API. It may use ordinary HTTP tooling
directly or choose the exported `EasyEmailClient` compatibility helper.

This is a source-level breaking change for unofficial deep-path consumers. No
compatibility re-export is retained because that would restore duplicate client
ownership inside the server package. The OpenAPI document is the supported,
language-neutral contract going forward; the independent client package and its
declarations remain optional convenience artifacts.

## Triggering a release

The coordinated `.github/workflows/release-easyemail.yml` workflow owns these
public tags and calls the Client/Userscript workflow:

- `vX.Y.Z`
- `release-YYYYMMDD-NNN`

The component workflow can also be started manually with a `release_tag` in one
of those formats. A `service-base-YYYYMMDD-NNN` tag is intentionally rejected
because it is scoped to the local server image.

## Pipeline

1. `preflight` calls `.github/workflows/reusable-validate.yml` without secrets.
2. `metadata` validates and resolves the release tag.
3. `build` compiles the TypeScript client, packs it, generates the Userscript, checks JavaScript syntax, writes a manifest and checksums, and verifies the exact output set.
4. `publish` downloads and verifies the distribution again, creates a build-provenance attestation, updates the managed GitHub Release notes section, and uploads the four release files.
5. The workflow retains a separate release-evidence artifact for 90 days.

## Optional TypeScript compatibility helper

The package under `clients/typescript` talks to the HTTP API exposed by
`service/base`. It is not required, does not start the server, and does not own
the API definition.

```ts
import { EasyEmailClient } from "easy-email-client";

const client = new EasyEmailClient({
  baseUrl: "http://127.0.0.1:18081",
  apiKey: process.env.EASY_EMAIL_API_KEY,
});

const catalog = await client.getCatalog();
```

The package contains ESM JavaScript and TypeScript declarations. Credentials are runtime inputs and are not baked into the package.

## Userscript boundary

The published `.user.js` file is a distributable template. It contains the tracked `__LOCAL_SECRET_*__` placeholders and does not contain repository secrets.

The Userscript remains a standalone provider runtime. It directly implements
provider access in the browser, does not call `service/base`, and does not share
the server's provider or mailbox business implementation. It may align with the
server only on provider names and externally defined upstream endpoints or
ports. Converting it into a thin HTTP client for `service/base` would be a
separate product and compatibility change, not a packaging optimization.

For a locally configured Userscript, continue to use the operator flow documented in `docs/build-userscript.md`. Never upload that configured output to a public release.

## Local reproduction

```powershell
Set-Location clients/typescript
npm ci
Set-Location ../..

python scripts/build-distribution.py `
  --release-tag v0.1.0 `
  --output-dir .tmp/client-userscript-release

python scripts/build-distribution.py `
  --verify-only `
  --output-dir .tmp/client-userscript-release
```

The output directory must be empty before the build. Verification rejects
missing files, extra files or directories, checksum drift, client-package
metadata drift, forbidden client files, unexpected Userscript placeholders, and
version/tag mismatch. The future bundled UI will require its own workflow and
manifest; it must not be inserted into this exact compatibility distribution.
