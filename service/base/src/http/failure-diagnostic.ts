const NETWORK_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_ABORTED", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
]);

const ERROR_NAMES = new Set([
  "Error", "TypeError", "AggregateError", "AbortError", "TimeoutError",
]);

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function routeCategory(path: string): string {
  const route = path.split("?")[0];
  if (/^\/mail\/mailboxes\/(open|release|send)$/.test(route ?? "")) {
    return route!;
  }
  const operation = route?.match(/^\/mail\/mailboxes\/[^/]+\/(refresh|code|auth-link)$/)?.[1];
  return operation ? `/mail/mailboxes/:sessionId/${operation}` : "other";
}

/** Deliberately omit messages, stacks, URLs, identifiers, headers and payloads. */
export function describeHttpFailure(method: string, path: string, error: unknown) {
  const causes: Array<{
    name: string; code?: string; fetchFailed: boolean;
    upstreamStatus?: number; timeoutReported?: boolean;
  }> = [];
  const seen = new Set<object>();

  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value) || causes.length >= 8) return;
    seen.add(value);
    const name = readProperty(value, "name");
    const code = readProperty(value, "code");
    const message = readProperty(value, "message");
    const prefix = typeof message === "string" ? message.slice(0, 256) : "";
    const status = prefix.match(/(?:with status|HTTP)\s+([1-5]\d\d)\b/)?.[1];
    causes.push({
      name: typeof name === "string" && ERROR_NAMES.has(name) ? name : "Error",
      ...(typeof code === "string" && NETWORK_CODES.has(code) ? { code } : {}),
      fetchFailed: message === "fetch failed",
      ...(status ? { upstreamStatus: Number(status) } : {}),
      ...(/\btimed out after \d+(?:\.\d+)?s\b/.test(prefix) ? { timeoutReported: true } : {}),
    });
    visit(readProperty(value, "cause"));
    const errors = readProperty(value, "errors");
    if (Array.isArray(errors)) {
      for (const nested of errors.slice(0, 8)) visit(nested);
    }
  }

  visit(error);
  return {
    event: "easy_email_http_failure",
    status: 500,
    method: method === "GET" || method === "POST" ? method : "OTHER",
    route: routeCategory(path),
    causes,
  };
}

export function reportHttpFailure(method: string, path: string, error: unknown): void {
  try {
    console.error(JSON.stringify(describeHttpFailure(method, path, error)));
  } catch {
    // Diagnostic failures must not prevent the HTTP error response.
  }
}
