# EasyEmail GitHub Actions And Client Distribution Plan

Status: approved direction, implementation in progress

## 1. Objective

EasyEmail should provide a fork-friendly delivery path with four explicit
surfaces:

1. publish the local `service/base` server as a verified GHCR image;
2. deploy the self-hosted `cloudflare_temp_email` provider to Cloudflare;
3. build and publish a secret-free Userscript artifact;
4. build and publish an EasyEmail HTTP Client artifact.

The GitHub repository is the control point for validation, publication, and
Cloudflare deployment. The local EasyEmail server remains a local or LAN
runtime: GitHub Actions publishes its immutable image and deployment assets,
while `deploy-host.ps1` installs or updates it on the target host.

## 2. Runtime Boundaries

### 2.1 EasyEmail Server

`service/base` is the local EasyEmail HTTP server. It owns:

- provider catalog and routing;
- provider credentials and instance health;
- mailbox planning, opening, sending, release, and recovery;
- message observation, OTP extraction, and authentication-link extraction;
- persistent runtime state and maintenance.

Client programs communicate with this server through HTTP. They must not import
provider adapters, persistence implementations, or server orchestration code.

### 2.2 Cloudflare Temp Email

`upstreams/cloudflare_temp_email` is an upstream-tracked, independently
deployable mail provider. It remains a separate deployment surface. EasyEmail
connects to a deployed instance through the `cloudflare_temp_email` provider
adapter; Cloudflare-specific Worker, D1, routing, frontend, and sending logic do
not move into the EasyEmail Client.

### 2.3 EasyEmail Client

The EasyEmail Client is a distributable HTTP API wrapper. Its first supported
implementation will be an ESM TypeScript/JavaScript package with declarations.
The package will contain only:

- HTTP transport and timeout handling;
- Bearer-token injection supplied at runtime;
- public route constants required by the client;
- public request and response DTOs;
- mailbox and message client methods.

It will not contain provider credentials, a default API key, server runtime
code, persistence code, or Cloudflare administrator credentials.

### 2.4 Userscript

`runtimes/userscript` remains an independently delivered browser runtime during
the first delivery phase. Publishing it does not silently change its current
direct-provider behavior into an EasyEmail Server client.

The public Userscript artifact must remain secret-free. Operator-specific
provider settings continue to use local generation or the existing encrypted
import-code/remote-config flow. GitHub Releases and ordinary workflow artifacts
must never contain a plaintext configured Userscript with live provider
credentials.

Converting or supplementing the Userscript with an explicit
`EasyEmail Server` mode is a separate product change and requires its own tests.

## 3. EasyProxy Reference Boundary

EasyProxy is a structural reference only. EasyEmail will reuse these patterns:

- a thin trigger workflow delegating to a reusable validation workflow;
- `preflight -> publish/deploy -> runtime verification` job ordering;
- normalized release metadata passed through job outputs;
- least-privilege workflow permissions;
- component-scoped Secrets and GitHub Environments;
- immutable artifacts, manifests, checksums, and provenance;
- serialized release/deploy concurrency with `cancel-in-progress: false`;
- diagnostic artifacts uploaded with `if: always()`;
- local and CI entrypoints calling the same repository scripts;
- bootstrap, update, verify, and rollback treated as different lifecycle steps.

EasyEmail will not copy EasyProxy's MiSub, Aggregator, ECH, topology,
candidate/stable publication, or Go native-release implementation.

## 4. Baseline State At Analysis Start

### 4.1 Existing capabilities at baseline

- `.github/workflows/validate.yml` runs the repository test matrix.
- `.github/workflows/publish-service-base-ghcr.yml` publishes the EasyEmail
  server image, validates it, publishes R2 configuration metadata, and creates
  an encrypted owner import-code artifact.
- `.github/workflows/deploy-cloudflare-email.yml` deploys and verifies the
  Cloudflare mail provider and can run a post-deploy sender matrix.
- `deploy-host.ps1` is the blank-host local server entrypoint.
- `scripts/compile-userscript.ps1` generates an operator-local configured
  Userscript.
- `service/base/src/consumer/http-client.ts` contained an initial HTTP client.

### 4.2 Gaps at baseline

- validation logic is embedded in the trigger workflow and cannot be reused as
  a secret-free publication preflight;
- the HTTP client is compiled as part of the private server package and has no
  independent package, declarations, version, artifact, or release contract;
- the Userscript has local validation but no secret-free distribution workflow;
- the release contract covers only `service/base` and treats Cloudflare as an
  exception instead of describing every public surface;
- there is no coordinated client/Userscript manifest or checksum set;
- current workflow contract tests do not prove reusable validation, artifact
  names, permission boundaries, or that distribution jobs receive no Secrets;
- server publication, Cloudflare deployment, and local root orchestration use
  related but separate implementations and need a clearer reusable boundary;
- public documentation does not yet distinguish a secret-free Userscript
  release from a locally generated configured Userscript.

### 4.3 Implemented repository state

- validation is owned by `reusable-validate.yml`, with `validate.yml` as a thin
  trigger wrapper;
- the typed HTTP Client is independently built and packed from
  `clients/typescript`; the duplicate private-server consumer implementation and
  its compatibility re-export have been removed;
- the secret-free Userscript and Client are built into one strict four-file
  distribution with checksums and provenance wiring;
- `release-contract.json` covers all three public surfaces and the coordinated
  release entrypoint;
- `release-easyemail.yml` owns public tags, runs one preflight, and serializes
  the selected reusable component workflows;
- hosted deployment, provider delivery, state-preserving upgrade, and rollback
  proof still require real fork credentials and an isolated/production run.

## 5. Target Repository Shape

```text
.github/
  workflows/
    validate.yml
    reusable-validate.yml
    publish-service-base-ghcr.yml
    deploy-cloudflare-email.yml
    publish-client-userscript.yml
    release-easyemail.yml
clients/
  typescript/
    package.json
    src/
    tests/
deploy/
  service/base/
  upstreams/cloudflare_temp_email/
runtimes/
  userscript/
service/
  base/
scripts/
  build-client-package.ps1
  build-userscript-release.ps1
  build-distribution-manifest.py
  validate-release-contract.py
```

The exact helper count may be smaller when one owner can remain cohesive. The
important rule is that workflows stay thin and call repository-owned scripts.

## 6. Workflow Topology

### 6.1 Validation

`validate.yml` is a trigger-only wrapper for `reusable-validate.yml`.

The reusable workflow:

- accepts no production Secrets;
- installs the supported Node/Python toolchains;
- runs root tests, Userscript validation, server typecheck/tests/build, Worker
  lint/build, frontend tests/build, and release-contract validation;
- finishes with `git diff --check` and a generated-file cleanliness check.

### 6.2 Server publication

`publish-service-base-ghcr.yml` keeps the existing server image, R2, and import
code responsibilities, but publication must depend on the reusable preflight.
Runtime smoke verification remains a separate post-publication gate.

### 6.3 Cloudflare deployment

`deploy-cloudflare-email.yml` keeps Cloudflare-specific bootstrap/update logic.
It must depend on the reusable preflight, use a protected Cloudflare
environment, serialize deployments, and retain a post-deploy readback manifest.

### 6.4 Client and Userscript publication

`publish-client-userscript.yml` builds only secret-free distribution artifacts:

- `easy-email-client-<release-tag>.tgz`;
- `easy-email-userscript-<release-tag>.user.js`;
- `easy-email-distribution-manifest.json`;
- `SHA256SUMS`.

It receives no Provider, Cloudflare, R2, or EasyEmail API Secrets. An EasyEmail
API key is always supplied by the client caller at runtime.

### 6.5 Coordinated release

`release-easyemail.yml` is the operator-facing workflow for coordinated public
releases. Its selectable targets are:

- `all`;
- `service-base`;
- `cloudflare-email`;
- `client-userscript`.

Reusable execution logic must use `workflow_call`; the public workflows remain
usable independently through `workflow_dispatch` and tag triggers. A release is
not considered complete merely because build jobs are green: each selected
surface must publish a manifest and pass its own runtime or artifact verifier.

## 7. Distribution Contracts

### 7.1 Client package

Minimum public methods:

- `getCatalog`;
- `getSnapshot`;
- `planMailbox`;
- `openMailbox`;
- `sendMailboxMessage`;
- `updateMailboxSession`;
- `releaseMailbox`;
- `recoverMailboxByEmail`;
- `recoverMailboxCapacity`;
- `readVerificationCode`;
- `readAuthenticationLink`;
- `reportMailboxOutcome`;
- `observeMessage`;
- `listObservedMessages`;
- `getObservedMessage`.

The package must ship ESM JavaScript, `.d.ts` declarations, `package.json`, a
README, and tests proving request method/path/body/auth/timeout/error behavior.
The Client API version and compatible EasyEmail Server API version must be
recorded in the distribution manifest.

### 7.2 Userscript artifact

The public Userscript must:

- pass `node --check`;
- contain a release version in its metadata block;
- contain no substituted operator credentials;
- retain only recognized local-secret placeholders where local/import-code
  configuration is expected;
- document that the configured local output is private and is not a release
  artifact.

### 7.3 Manifest and checksums

The distribution manifest must include:

- schema version;
- repository, commit, workflow, run, and release tag;
- artifact file names, sizes, and SHA-256 digests;
- client package/API compatibility metadata;
- Userscript runtime mode;
- validation results;
- provenance/attestation status when available.

Verification must reject missing, extra, renamed, or checksum-mismatched files.

## 8. Secrets And Trust Boundaries

| Surface | Allowed secret scope | Forbidden output |
| --- | --- | --- |
| reusable validation | none | all production credentials |
| client/Userscript distribution | none | API keys, provider tokens, configured Userscript |
| server GHCR | GHCR plus explicitly required R2/import-code credentials | plaintext runtime config and private key material |
| Cloudflare deployment | Cloudflare and configured sending-provider credentials | Wrangler config with secrets, admin JWT/passwords |
| local server install | operator-supplied import code or private runtime config | credentials in logs or release manifests |

Secrets must be passed through environment variables or secret files, never
command-line arguments that are printed by workflow shells. Temporary
secret-bearing files must be deleted in an `always()` cleanup step and must not
be included by broad artifact globs.

## 9. Implementation Phases

### Phase 0 - Baseline and evidence

- query the existing Graphify graphs for EasyEmail and EasyProxy;
- inspect current architecture, workflows, scripts, contracts, and tests;
- recover relevant EasyProxy decisions from the referenced historical session;
- record the dirty EasyEmail worktree and avoid unrelated files.

Exit condition: current-state and reference-pattern evidence is available with
file/line anchors. This phase is complete.

### Phase 1 - Reusable validation foundation

- add `.github/workflows/reusable-validate.yml` with no inputs or Secrets;
- make `validate.yml` a thin wrapper;
- add `workflow_dispatch` for manual validation;
- add workflow contract tests for triggers, permissions, reusable invocation,
  secret absence, and generated-file cleanliness;
- run the current repository validation and release-contract check.

Exit condition: PR/push/manual validation all use one implementation and no
publication workflow needs to duplicate it.

### Phase 2 - Independent EasyEmail Client

- create `clients/typescript` and move the client-owned transport/API surface
  out of the private server package;
- define the minimal public DTO boundary rather than importing server workers,
  persistence, or provider code;
- add unit tests for every public route family and transport failure mode;
- add a deterministic package build and `npm pack` smoke test;
- decide and document the temporary migration path for the existing
  `service/base/src/consumer` exports, then remove duplicate ownership.

Exit condition: a clean checkout can build and install the package without
building or importing the EasyEmail server.

### Phase 3 - Secret-free Userscript distribution

- add a release builder that copies the tracked template, writes release
  metadata, verifies recognized placeholders, and runs syntax checks;
- keep `compile-userscript.ps1` as the private local configured path;
- add tests proving public artifacts contain no configured credentials;
- document standalone and future server-client modes explicitly.

Exit condition: Actions can publish an installable secret-free `.user.js`
without access to repository Secrets.

### Phase 4 - Distribution workflow and release contract

- add `publish-client-userscript.yml`;
- build the client and Userscript in an unprivileged job;
- generate strict manifest/checksum files;
- upload workflow artifacts and GitHub Release assets;
- expand `release-contract.json` and its validator to cover server, Cloudflare,
  Client, Userscript, checksums, and provenance;
- add release-contract regression tests including tampering and extra-file cases.

Exit condition: the declared artifact set exactly matches the generated and
verified release set.

### Phase 5 - Reusable publish/deploy and coordinated release

- extract reusable execution boundaries from the existing server and
  Cloudflare workflows without changing their business behavior;
- add protected environments, least-privilege permissions, concurrency groups,
  and explicit preflight dependencies;
- add `release-easyemail.yml` as the selectable operator entrypoint;
- keep independent component workflows for focused updates;
- ensure root local scripts and hosted workflows call the same helpers.

Exit condition: a fork operator can select components, provide only the
required Secrets, and receive deterministic manifests for every selected
surface.

### Phase 6 - End-to-end verification and rollback proof

- validate workflow YAML/contracts locally;
- publish a candidate Client/Userscript artifact set and install/syntax-test it;
- build and smoke the candidate server image;
- dry-run or deploy Cloudflare in an isolated/test target before production;
- verify server HTTP calls through the published Client;
- prove local update preserves runtime config/state;
- record rollback instructions and immutable prior artifact references.

Exit condition: artifact existence, checksums, installability, HTTP semantics,
runtime paths, and update preservation are all freshly verified.

## 10. Stop Conditions

The work is complete only when all of the following are true:

- one reusable, secret-free validation workflow is authoritative;
- the EasyEmail Client is independently buildable and installable;
- the public Userscript is independently buildable and secret-free;
- release contracts enumerate every public surface and exact artifact;
- selected GitHub Actions publish/deploy real outputs and emit verified
  manifests;
- the local server remains deployable from a blank host without a source-tree
  bind mount;
- Cloudflare deployment and local-server update paths preserve state or provide
  an explicit tested rollback;
- no live credential appears in Git, logs, public artifacts, or manifests.

## 11. Non-Goals

- copying EasyProxy business logic or topology models;
- modifying the EasyProxy repository;
- rewriting the upstream Cloudflare Temp Email project as first-party code;
- publishing a plaintext configured Userscript;
- treating a green build without runtime/artifact verification as deployment
  success;
- changing the Userscript to server mode implicitly as part of CI work.
