# ADR 0004: Use A Private Parent-Child Control Channel For Graceful Shutdown

- Status: Accepted
- Date: 2026-09-01
- Milestone: M0

## Context

The Tauri host starts exactly one packaged `service/base` child, chooses an
ephemeral loopback port, creates a runtime-only API token, and waits for an
authenticated catalog response. Normal close currently calls `kill()` and
`wait()` because the Node core has no graceful shutdown mechanism.

Graceful shutdown must drain HTTP requests and workers, flush persistence, and
close listeners. It must not add a public shutdown endpoint that any renderer
script or standalone API caller can invoke, and it must never terminate an
independently started server.

## Decision

1. Bundled mode uses a private, inherited parent-child control channel. The
   initial implementation is newline-delimited JSON on piped child stdin.
2. Tauri starts the child with an explicit bundled-child flag and piped stdin.
   Standalone mode does not reserve stdin or enable the control protocol.
3. The version 1 control message is:

   ```json
   { "protocolVersion": 1, "command": "shutdown" }
   ```

4. On a valid shutdown request the core:
   - stops accepting new HTTP connections;
   - reports a shutting-down runtime state to in-flight components;
   - stops scheduling new maintenance, provider, IMAP, and SMTP queue work;
   - waits up to a bounded drain deadline;
   - flushes persistence and closes the listener;
   - exits with a defined success code.
5. Tauri waits for the child until its own bounded deadline. If the control
   channel is unavailable, the child does not understand the protocol, or the
   deadline expires, Tauri terminates and reaps only the exact child it created.
6. Parent-channel EOF is treated as an unexpected parent exit and starts the
   same bounded shutdown path. Automatic restart, if later added, is bounded and
   visible; it never hides a crash loop.
7. Graceful control remains outside the public OpenAPI contract. The renderer
   never receives a shutdown credential or direct control-channel handle.

## Rejected Alternatives

### Public `POST /mail/runtime/shutdown`

Rejected because it exposes a process-lifecycle operation through the business
API and makes the renderer's bearer token sufficient to stop the core. It also
has no value for independently managed standalone servers.

### Always send an operating-system signal

Rejected as the primary protocol because Windows signal behavior differs from
Unix and does not provide an application-level drain acknowledgement.

### Keep unconditional `kill()` on normal close

Rejected because it can interrupt persistence and queue transitions and cannot
prove a clean product lifecycle.

## Migration And Rollback

- The host feature-detects the control protocol. Existing packaged cores keep
  working through the current exact-child kill/wait fallback.
- The control protocol and drain implementation land before the host switches
  normal close to require graceful success.
- If graceful behavior regresses, rollback restores the previous host binary;
  exact-child fallback remains available and no public HTTP contract changes.

## Acceptance

- Unit tests cover valid, malformed, repeated, and EOF control messages.
- Service tests prove listener close, worker stop, persistence flush, and bounded
  drain behavior.
- Host smoke proves normal close uses the control path and reaps the child.
- A forced-timeout fixture proves fallback kills only the exact child.
- Closing the UI does not affect an independently started `service/base`.
- No orphan child remains after normal close, UI crash recovery, or fallback.

