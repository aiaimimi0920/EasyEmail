import type {
  EasyEmailHttpClientOptions,
  EasyEmailHttpQuery,
  EasyEmailHttpRequest,
} from "./easyEmailCoreTypes.ts";

export type EasyEmailRequestTransport = <T>(request: EasyEmailHttpRequest) => Promise<T>;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export function normalizeEasyEmailHttpBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EasyEmail service URL must be an absolute HTTP or HTTPS URL.");
  }

  if (url.username || url.password) {
    throw new Error("EasyEmail service URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("EasyEmail service URL must not contain a query string or fragment.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("EasyEmail service URL must use HTTP or HTTPS.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Plain HTTP is allowed only for a loopback EasyEmail service.");
  }

  return url.toString().replace(/\/$/, "");
}

function buildRequestUrl(baseUrl: string, path: string, query?: EasyEmailHttpQuery): string {
  if (!path.startsWith("/")) {
    throw new Error("EasyEmail HTTP paths must start with '/'.");
  }

  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function errorMessageFromPayload(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "error"]) {
      if (typeof record[key] === "string" && record[key]) {
        return record[key];
      }
    }
  }
  return `EasyEmail HTTP request failed with status ${status}.`;
}

export class EasyEmailHttpError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "EasyEmailHttpError";
    this.status = status;
    this.payload = payload;
  }
}

export function createEasyEmailRequestTransport(
  options: EasyEmailHttpClientOptions,
): EasyEmailRequestTransport {
  const baseUrl = normalizeEasyEmailHttpBaseUrl(options.baseUrl);
  const bearerToken = options.bearerToken?.trim();
  const fetchRequest = options.fetch ?? globalThis.fetch;
  if (typeof fetchRequest !== "function") {
    throw new Error("EasyEmail HTTP transport requires fetch.");
  }

  return async function request<T>(requestOptions: EasyEmailHttpRequest): Promise<T> {
    const hasBody = requestOptions.body !== undefined;
    const headers = new Headers({ accept: "application/json" });
    if (hasBody) headers.set("content-type", "application/json");
    if (bearerToken) headers.set("authorization", `Bearer ${bearerToken}`);

    const response = await fetchRequest(
      buildRequestUrl(baseUrl, requestOptions.path, requestOptions.query),
      {
        method: requestOptions.method ?? "GET",
        headers,
        body: hasBody ? JSON.stringify(requestOptions.body) : undefined,
        redirect: "error",
        signal: requestOptions.signal,
      },
    );

    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        if (!response.ok) {
          throw new EasyEmailHttpError(
            response.status,
            `EasyEmail HTTP request failed with status ${response.status}.`,
            text,
          );
        }
        throw new Error("EasyEmail returned invalid JSON.");
      }
    }

    if (!response.ok) {
      throw new EasyEmailHttpError(
        response.status,
        errorMessageFromPayload(payload, response.status),
        payload,
      );
    }
    return payload as T;
  };
}
