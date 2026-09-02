# ADR 0003: Keep Desktop Secrets In The OS Vault Behind Opaque References

- Status: Accepted
- Date: 2026-09-01
- Milestone: M0

## Context

EasyEmailAM already stores credential metadata separately from secret material
and uses Windows Credential Manager through a Rust `SecretVaultAdapter`.
`service/base` can currently resolve provider credential definitions that may
contain values, usernames, or passwords from standalone runtime configuration.

The final desktop UI must use the same `service/base` business core without
putting account passwords or tokens in SQLite, HTTP logs, browser storage,
static assets, or long-lived process configuration. At the same time, a
standalone server cannot depend on a Tauri process.

## Decision

1. Business models, HTTP responses, and persistence store only an opaque
   `credentialRef` plus non-secret backend/key metadata.
2. In bundled desktop mode, Tauri remains the OS integration owner:
   - the webview submits a new secret through a narrowly scoped Tauri vault
     command;
   - Tauri writes it to the operating-system credential vault;
   - the webview receives only an opaque reference;
   - later `service/base` operations resolve that reference through a private,
     authenticated, child-only credential broker owned by the Tauri host.
3. The broker authorizes the requested account/provider scope before resolving
   a reference. It never offers list-all or arbitrary target-name access.
4. Resolved secret bytes are short-lived in the core process, never included in
   errors or telemetry, and cleared/released as soon as the protocol operation
   finishes.
5. The existing `EasyEmailAM:` Windows Credential Manager target prefix and old
   opaque keys remain readable until the M8 importer and rollback window pass.
   New references use a versioned opaque format; callers must not parse it.
6. Standalone mode uses configured server-side secret resolvers (environment,
   protected file, or operator secret manager). It implements the same resolver
   interface but does not require Tauri.
7. A missing resolver/reference returns a stable
   `reauthentication_required`/`credential_unavailable` error. It never deletes
   the account or silently substitutes an empty secret.
8. Non-loopback standalone deployments must use TLS or a trusted TLS reverse
   proxy, a strong API key, and network ACLs. Secrets are never accepted in URL
   query parameters.

### Bundled desktop broker protocol

- On every desktop-core start, the Tauri host binds a fresh broker listener to
  an ephemeral `127.0.0.1` port and generates an independent high-entropy bearer
  token. The URL and token are passed only to the exact Node child through its
  environment; they are not part of the renderer runtime descriptor.
- The Node resolver may call only `POST /v1/credentials/resolve`. Its JSON body
  contains account ID, credential-ref ID, backend/key metadata, credential kind,
  authentication method, and use case; it never contains a raw secret.
- Before reading the vault, the broker calls the authenticated canonical
  `GET /mail/accounts/{accountId}` route and requires an exact match for account
  ownership and every credential-ref metadata field. The initial allowlist is
  limited to `imap-test` with `imap_password/password`.
- Successful replies contain the one resolved secret and use `Cache-Control:
  no-store`. The broker has no list operation, rejects ambiguous HTTP message
  framing, applies three-second I/O/scope timeouts, and clears temporary secret
  buffers on a best-effort basis after the response is written.
- The broker token is rotated on each desktop-core start. It is a bounded-lived
  bearer capability, not a replay-proof protocol; loopback binding, token
  confidentiality, exact-ref authorization, and shutdown with the child are all
  required together.

The production account connection tester is implemented in `service/base` with
ImapFlow. It resolves the secret only at operation time, requires TLS or forced
STARTTLS with TLS 1.2 or newer, disables protocol logging and automatic IDLE, and
bounds connect, socket, greeting, and logout cleanup time. Standalone runtimes
use the same resolver/tester interfaces but do not start the desktop broker.

## Rejected Alternatives

### Store encrypted credential blobs in SQLite

Rejected because key management would still be required, backups would carry
credential material, and the design would duplicate the OS vault.

### Send all saved credentials to `service/base` at startup

Rejected because it creates a long-lived plaintext bundle in process arguments,
environment, configuration, or memory and broadens the impact of diagnostics.

### Let `service/base` call platform vault APIs directly in desktop mode

Rejected for the migration because it duplicates OS integration across Node and
Tauri and makes the packaged core platform-specific. The broker keeps the core
resolver contract portable.

## Migration And Rollback

- M3 introduces the resolver/broker interface, production ImapFlow connection
  tester, and fake-vault/broker contract tests.
- During migration, reads accept existing opaque keys; writes use the new
  versioned reference format.
- M8 imports only reference metadata and verifies that each OS-vault entry
  exists. Missing entries are marked for reauthentication.
- Rollback preserves all old vault entries and target prefixes. Uninstall and
  downgrade never delete credentials automatically.

## Acceptance

- A canary secret has zero matches in SQLite, state files, web storage, logs,
  stdout/stderr, crash reports, manifests, and diagnostic archives.
- Broker calls are authenticated, scope-checked, time-bounded, and unavailable
  to unrelated local processes.
- Cross-account reference access is rejected.
- Restart resolves valid references; missing references fail closed.
- Fake-vault tests run on every platform; Windows Credential Manager integration
  runs in the protected Windows validation environment.
