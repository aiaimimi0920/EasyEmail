import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { normalizeMailProviderTypeKey, type MailProviderTypeKey } from "../domain/provider-taxonomy.js";

export function fetchProviderResource(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  return globalThis.fetch(input, {
    ...init,
    redirect: "error",
  });
}

type RecoveryCode = "UND_ERR_CONNECT_TIMEOUT" | "UND_ERR_SOCKET" | "ECONNRESET";

function recoveryCode(error: unknown): RecoveryCode | undefined {
  try {
    for (let depth = 0; depth < 8 && error && typeof error === "object"; depth += 1) {
      const current = error as { code?: unknown; cause?: unknown };
      if (current.code === "UND_ERR_CONNECT_TIMEOUT" || current.code === "UND_ERR_SOCKET" || current.code === "ECONNRESET") {
        return current.code;
      }
      error = current.cause;
    }
  } catch {
    // Preserve the original failure when an error object cannot be inspected.
  }
  return undefined;
}

function transportFailurePhase(error: unknown, code: RecoveryCode | undefined) {
  // Undici's HTTPS connect timer also covers TLS, not just the TCP handshake.
  if (code === "UND_ERR_CONNECT_TIMEOUT") return "connect_or_tls";
  try {
    for (let depth = 0; depth < 8 && error && typeof error === "object"; depth += 1) {
      const current = error as { code?: unknown; message?: unknown; cause?: unknown };
      if (current.code === "ECONNRESET"
        && current.message === "Client network socket disconnected before secure TLS connection was established") {
        return "tls_handshake";
      }
      error = current.cause;
    }
  } catch {
    // Unknown or hostile error objects must not change transport behavior.
  }
  return "unknown";
}

export async function fetchProviderResourceWithRecovery(
  input: string,
  init: RequestInit = {},
  providerTypeKey?: MailProviderTypeKey,
): Promise<Response> {
  const startedAt = performance.now();
  try {
    return await fetchProviderResource(input, init);
  } catch (error) {
    const code = recoveryCode(error);
    const method = (init.method ?? "GET").toUpperCase();
    const replayableBody = init.body == null || typeof init.body === "string";
    // A connect timeout precedes sending; a socket failure may follow a write.
    const safeToRetry = code === "UND_ERR_CONNECT_TIMEOUT"
      || ((method === "GET" || method === "HEAD") && (code === "UND_ERR_SOCKET" || code === "ECONNRESET"));
    if (!safeToRetry || !replayableBody || init.signal?.aborted) throw error;
    try {
      console.warn(JSON.stringify({
        event: "easy_email_upstream_retry",
        ...retryAttribution(input, providerTypeKey),
        method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER",
        code,
        elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
        transportPhase: transportFailurePhase(error, code),
        attempt: 2,
      }));
    } catch {
      // Logging must not interrupt recovery.
    }
    // Keep the caller's existing signal: the second attempt gets no new deadline.
    return fetchProviderResource(input, init);
  }
}

function retryAttribution(input: string, provider?: MailProviderTypeKey) {
  const providerTypeKey = normalizeMailProviderTypeKey(provider);
  const url = URL.parse(input);
  // Correlate origins without writing hostnames, userinfo, paths, or queries.
  const upstreamRef = url && (url.protocol === "https:" || url.protocol === "http:")
    ? createHash("sha256").update(url.origin).digest("hex").slice(0, 16)
    : undefined;
  return {
    ...(providerTypeKey ? { providerTypeKey } : {}),
    ...(upstreamRef ? { upstreamRef } : {}),
  };
}
