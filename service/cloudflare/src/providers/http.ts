import { HttpError } from "../http";

// No automatic retry: a timed-out upstream write may already have succeeded.
export async function providerJson(base: string, path: string, headers: Record<string, string>,
  signal: AbortSignal, body?: unknown, options: { expectedStatus?: number; maxBytes?: number; notFoundCode?: string } = {}): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { ...headers, accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 && options.notFoundCode) throw new HttpError(409, options.notFoundCode);
      const code = response.status === 401 || response.status === 403 ? "provider_auth_failed"
        : response.status === 429 ? "provider_rate_limited" : "provider_unavailable";
      throw new HttpError(502, code);
    }
    if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
      await response.body?.cancel();
      throw new HttpError(502, "provider_invalid_response");
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      await response.body?.cancel();
      throw new HttpError(502, "provider_invalid_response");
    }
    reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, "provider_invalid_response");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > (options.maxBytes ?? 2 * 1024 * 1024)) {
        await reader.cancel();
        throw new HttpError(502, "provider_response_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, signal.aborted ? "provider_timeout" : "provider_invalid_response");
  } finally { reader?.releaseLock(); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(502, "provider_invalid_response");
  return value as Record<string, unknown>;
}

export function string(value: unknown, max = 131072): string {
  if (typeof value !== "string" || value.length > max) throw new HttpError(502, "provider_invalid_response");
  return value;
}

export function optionalString(row: Record<string, unknown>, names: string[], max = 131072): string {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) {
      const value = string(row[name], max);
      if (value) return value;
    }
  }
  return "";
}

export function remoteId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  const id = string(value, 256);
  if (!id) throw new HttpError(502, "provider_invalid_response");
  return id;
}

export function receivedTime(value: unknown, sqlite = false): number | null {
  if (typeof value !== "string") return null;
  const raw = sqlite && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
