# GitHub Actions Release Operations

This runbook covers the hosted release boundary for the three EasyEmail
surfaces. It does not replace provider-specific configuration documentation.

## Entry points

Use `.github/workflows/release-easyemail.yml` for public releases. A pushed
`vX.Y.Z` or `release-YYYYMMDD-NNN` tag selects `all` and runs these surfaces in
order:

1. Client and secret-free Userscript distribution;
2. `service/base` image and bootstrap metadata publication;
3. Cloudflare email deployment and runtime readback.

The coordinator runs `reusable-validate.yml` once before any publication. It
then calls the three component workflows with their duplicate preflights
disabled. A later surface never starts after an earlier selected surface fails.
The release is sequential, but it is not transactional: an earlier artifact can
already be public when a later deployment fails. In that case the tag is a
partial release until the failed target is successfully retried or the prior
release is restored.

The coordinator's manual target choices are `all`, `service-base`,
`cloudflare-email`, and `client-userscript`. Component workflows retain direct
`workflow_dispatch` entry points for focused maintenance. The
`service-base-YYYYMMDD-NNN` tag family continues to trigger only the service
workflow.

## Required GitHub environments

Create these environments before the first hosted run:

| Environment | Used by | Recommended protection |
| --- | --- | --- |
| `easyemail-public-release` | Client/Userscript publish job | public-tag restriction and optional reviewer |
| `easyemail-service-production` | GHCR/R2/import-code publication | required reviewer and public/service tag restriction |
| `easyemail-cloudflare-validation` | direct Cloudflare dry runs | no production deployment credentials unless required for read-only validation |
| `easyemail-cloudflare-production` | Cloudflare publication | required reviewer and public-tag restriction |

GitHub creates an unconfigured environment when one is first referenced. Merely
naming an environment in YAML does not create reviewer or tag protections; the
repository owner must configure those rules in GitHub settings.

The Client/Userscript reusable call receives no production secrets. The
coordinator passes available secrets only to the service and Cloudflare called
workflows; those workflows read their documented named values. Configure the
minimum set described in `docs/github-actions-secrets.md`, preferably as secrets
on the corresponding protected environment.

## Pre-release procedure

1. Confirm the target commit is the intended release commit and the worktree
   contains no generated credentials.
2. Run `pwsh ./scripts/test-all.ps1` from the repository root.
3. Build and independently verify a distribution candidate with
   `scripts/build-distribution.py`.
4. For Cloudflare changes, run the direct Cloudflare workflow with `dry_run`
   before selecting a production target.
5. Confirm environment approvals, GHCR package access, Cloudflare configuration,
   R2 configuration, and import-code encryption keys are present.
6. Push a public tag, or manually run `Release EasyEmail` with an explicit tag
   and target.

Do not run multiple component workflows against the same GitHub Release while a
coordinated release is active. Component concurrency keys protect each surface;
the coordinator owns the cross-surface `release-<tag>` lock and sequencing.

## Acceptance evidence

A selected surface is successful only after its own evidence is available:

| Surface | Required evidence |
| --- | --- |
| Client/Userscript | exact four-file set, verified manifest and `SHA256SUMS`, package install/syntax checks, provenance attestation |
| Service base | release manifest containing image reference and registry digest, GHCR image, R2 manifest, encrypted import-code artifact, container smoke result |
| Cloudflare email | deployment manifest, deployment notes, `/health_check` and `/open_api/settings` readback, sender-matrix result when enabled |

Record the Actions run URL, release tag, commit SHA, artifact checksums,
attestation reference, service image digest, and previous known-good tag in the
change record. Protect public release tags from deletion or movement in GitHub.
Do not use `latest`, an unverified tag name, or a mutable Release URL as rollback
evidence.

## Retry and partial releases

If one selected surface fails, do not create a new tag just to hide the failure.
Inspect the failed component's evidence and retry that target from the
coordinator using the same release tag after correcting credentials or external
state. The component workflows update only their managed release-note section
and named assets. Verify all selected sections and assets again after a retry.

## Rollback

### Client and Userscript

Use the prior known-good GitHub Release tag and verify that it still resolves to
the recorded commit SHA. Verify `SHA256SUMS` and the provenance attestation
before installing the `.tgz` or `.user.js`. A tag is an immutable rollback
reference only when repository protection prevents deletion/movement and the
recorded SHA still matches; Git tags and Release assets are not inherently
immutable. Never use a locally configured Userscript as a public rollback
artifact. The project does not automatically replace already-installed
Userscripts, so operators must reinstall or repin the prior file explicitly.

### Local `service/base`

Read the prior `service-base-release-manifest.json` and copy its exact
`release.digest`. Redeploy the same instance with the same config and runtime
root, pinning the digest rather than a mutable tag:

```powershell
pwsh ./scripts/deploy-service-base.ps1 `
  -ConfigPath ./config.yaml `
  -NoBuild `
  -Image ghcr.io/OWNER/easy-email-service@sha256:DIGEST `
  -Pull
```

For a named installation, also pass the same `-InstanceName`, `-RuntimeRoot`,
ports, and compose project values used by that installation. The compose data
mount is deliberately reused. Do not run either remove script during an image
rollback because removal can destroy the state that rollback is intended to
preserve. After redeploying, verify the HTTP health endpoint and make semantic
catalog/open/read calls through the packaged Client.

### Cloudflare email

Run `.github/workflows/deploy-cloudflare-email.yml` manually at the previous
known-good Git tag/ref using the same protected production environment. Keep
`bootstrap_missing_resources` disabled and retain the existing D1 resource and
routing configuration unless the incident specifically requires a routing
repair. Verify `/health_check`, `/open_api/settings`, domain/routing state, and a
sender-matrix sample after the old Worker/frontend code is restored.

This repository currently has no automated D1 data-restore command. The backup
created by `remove-cloudflare-email.ps1` is a topology/removal safety record, not
proof of a tested database restore. A schema/data incident therefore requires a
separately reviewed Cloudflare backup/restore procedure; do not claim full data
rollback from the deployment workflow alone.

## Proof boundary

Local tests can prove YAML shape, contracts, deterministic artifact generation,
checksums, package contents, and local server behavior. Only a hosted run with
real fork credentials can prove GitHub environment approval, GHCR/R2 upload,
GitHub Release mutation, attestation, Cloudflare deployment/readback, DNS/mail
delivery, cross-version state preservation, and a production rollback drill.
