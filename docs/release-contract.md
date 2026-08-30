# Release Contract

Project: `EasyEmail`

Release class: `multi-surface-service-and-client-distribution`

This repository follows the EasyAiMi release contract v1 across three independently deployable or distributable surfaces. A public `vX.Y.Z` or `release-YYYYMMDD-NNN` tag drives the coordinated release workflow, while a `service-base-YYYYMMDD-NNN` tag remains restricted to the local server image.

## Release surfaces

### Local EasyEmail server

`service/base` is the local HTTP server used by EasyEmail clients. Its workflow publishes the GHCR image, release manifest, R2 bootstrap metadata, and encrypted owner import-code artifact. Blank-host deployment starts from `deploy-host.ps1`.

### Cloudflare email center

`upstreams/cloudflare_temp_email` is deployed by the Cloudflare workflow. The workflow materializes operator configuration from GitHub secrets, deploys the Worker/frontend resources, reads back `/health_check` and runtime settings, and uploads deployment evidence. Dry-run and bootstrap controls remain workflow-dispatch inputs.

### Client and Userscript distribution

`clients/typescript` is a secret-free HTTP client for `service/base`. `runtimes/userscript` remains an independent, direct-provider runtime in this release phase; it is not silently changed into a `service/base` client.

The distribution workflow creates exactly four release files:

- `easy-email-client-<release-tag>.tgz`
- `easy-email-userscript-<release-tag>.user.js`
- `easy-email-distribution-manifest.json`
- `SHA256SUMS`

The manifest and checksums are verified again after artifact download and before GitHub Release publication. The workflow also emits a build-provenance attestation and a 90-day evidence artifact.

## Workflow contract

`.github/workflows/release-easyemail.yml` is the only public-tag owner. It runs
one secret-free preflight, then invokes the selected reusable component
workflows in `client-userscript -> service-base -> cloudflare-email` order.

| Component | Workflow | Tag inputs | Required artifacts | Required capabilities |
| --- | --- | --- | --- | --- |
| `service-base` | `.github/workflows/publish-service-base-ghcr.yml` | `release_tag, version` | `service-base-release-manifest, service-base-r2-config-manifest, service-base-import-code-encrypted` | GHCR, R2, encrypted import-code, GitHub Release |
| `cloudflare-email` | `.github/workflows/deploy-cloudflare-email.yml` | deployment controls | `cloudflare-email-release-manifest, cloudflare-email-deployment-notes, cloudflare-email-runtime-readback` | Cloudflare deployment, health/readback evidence, GitHub Release |
| `client-userscript` | `.github/workflows/publish-client-userscript.yml` | `release_tag` | `easy-email-client-userscript-distribution, easy-email-client-userscript-release-evidence` | reusable preflight, exact distribution verification, attestation, GitHub Release |

The coordinator owns `release-<release-tag>` with `cancel-in-progress: false`.
Component workflows use component-scoped locks for focused manual runs. This
avoids concurrent managed-release-note updates on the public path; direct
component runs must not be launched concurrently against the same release.

Production jobs use the `easyemail-public-release`,
`easyemail-service-production`, and `easyemail-cloudflare-production` GitHub
environments. A direct Cloudflare dry run uses
`easyemail-cloudflare-validation`. Repository owners must configure protection
rules; the names alone do not make environments protected.

## Security boundaries

- The public Userscript is generated from the tracked template and contains only the known `__LOCAL_SECRET_*__` placeholders. The release builder fails closed if that placeholder set changes.
- A Userscript generated locally from `config.yaml` may contain operator credentials and must never be uploaded by the public release workflow.
- Client authorization is supplied at runtime through the client constructor. No API key, token, `.env`, `.npmrc`, or deployment configuration belongs in the npm archive.
- The Client/Userscript publishing workflow receives no repository or environment secrets. Its only elevated job permissions are GitHub Release writes and artifact attestation.

## Local verification

Run the repository release-contract check:

```powershell
python scripts/validate-release-contract.py
```

Build and then independently verify the distribution:

```powershell
python scripts/build-distribution.py `
  --release-tag release-20260831-001 `
  --output-dir .tmp/client-userscript-release

python scripts/build-distribution.py `
  --verify-only `
  --output-dir .tmp/client-userscript-release
```

These checks validate local source and artifact contracts. They do not claim that a hosted GitHub Actions run, GitHub Release upload, Cloudflare deployment, GHCR push, R2 upload, or provenance attestation has occurred.

See `docs/release-operations.md` for the hosted procedure, acceptance evidence,
partial-release handling, and rollback boundaries.
