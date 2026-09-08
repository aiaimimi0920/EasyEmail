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

export async function fetchProviderResourceWithRecovery(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
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
        method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER",
        code,
        attempt: 2,
      }));
    } catch {
      // Logging must not interrupt recovery.
    }
    // Keep the caller's existing signal: the second attempt gets no new deadline.
    return fetchProviderResource(input, init);
  }
}
