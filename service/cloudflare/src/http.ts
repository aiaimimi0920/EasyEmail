export class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export const MAX_REQUEST_BYTES = 8192;

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new HttpError(415, "json_required");
  }
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new HttpError(413, "body_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_json");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "body_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid object");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json");
  } finally {
    reader.releaseLock();
  }
}

export function textField(body: Record<string, unknown>, name: string, min: number, max: number): string {
  const value = body[name];
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HttpError(400, `invalid_${name}`);
  }
  return value;
}

export function pageOptions(url: URL): { limit: number; cursor: string } {
  const rawLimit = url.searchParams.get("limit") ?? "25";
  const cursor = url.searchParams.get("cursor") ?? "";
  if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
    throw new HttpError(400, "invalid_limit");
  }
  if (cursor && !/^[0-9a-f-]{36}$/.test(cursor)) throw new HttpError(400, "invalid_cursor");
  return { limit: Number(rawLimit), cursor };
}

export function secured(response: Response, requestId: string): Response {
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.headers.set("x-request-id", requestId);
  return response;
}
