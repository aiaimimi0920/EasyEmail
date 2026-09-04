import type { MailTaxonomyKind } from "./contracts-catalog.js";

export const EASY_EMAIL_HTTP_ROUTES = {
  catalog: "/mail/catalog",
  snapshot: "/mail/snapshot",
  queryObservedMessages: "/mail/query/observed-messages",
  contacts: "/mail/contacts",
  taxonomy: "/mail/taxonomy",
  accounts: "/mail/accounts",
  testAccountImap: "/mail/accounts/imap/test",
  planMailbox: "/mail/mailboxes/plan",
  openMailbox: "/mail/mailboxes/open",
  sendMailboxMessage: "/mail/mailboxes/send",
  updateMailboxSession: "/mail/mailboxes/update-session",
  releaseMailbox: "/mail/mailboxes/release",
  recoverMailboxByEmail: "/mail/mailboxes/recover-by-email",
  recoverMailboxCapacity: "/mail/mailboxes/recover-capacity",
  reportMailboxOutcome: "/mail/mailboxes/report-outcome",
  observeMessage: "/mail/messages/observe",
  readVerificationCode(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/code`;
  },
  readAuthenticationLink(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/auth-link`;
  },
  getObservedMessage(messageId: string): string {
    return `/mail/query/observed-messages/${encodeURIComponent(messageId)}`;
  },
  contact(contactId: string): string {
    return `/mail/contacts/${encodeURIComponent(contactId)}`;
  },
  taxonomyItem(itemId: string): string {
    return `/mail/taxonomy/${encodeURIComponent(itemId)}`;
  },
  taxonomyUpsert(kind: MailTaxonomyKind, key: string): string {
    return `/mail/taxonomy/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;
  },
  account(accountId: string): string {
    return `/mail/accounts/${encodeURIComponent(accountId)}`;
  },
  disableAccount(accountId: string): string {
    return `/mail/accounts/${encodeURIComponent(accountId)}/disable`;
  },
} as const;

export interface FetchJsonHttpClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface QueryParameters {
  [key: string]: string | number | boolean | undefined;
}

export interface JsonHttpClient {
  get<TResponse>(path: string, query?: QueryParameters): Promise<TResponse>;
  post<TRequest, TResponse>(path: string, body: TRequest): Promise<TResponse>;
  put<TRequest, TResponse>(path: string, body: TRequest): Promise<TResponse>;
  patch<TRequest, TResponse>(path: string, body: TRequest): Promise<TResponse>;
  delete<TResponse>(path: string, query?: QueryParameters): Promise<TResponse>;
}

export class EasyEmailHttpError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "EasyEmailHttpError";
  }
}

export class EasyEmailTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`EasyEmail HTTP request timed out after ${timeoutMs}ms.`);
    this.name = "EasyEmailTimeoutError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new TypeError("EasyEmail baseUrl is required.");
  }

  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("EasyEmail baseUrl must use http or https.");
  }
  return normalized;
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const normalizedApiKey = apiKey?.trim();
  if (normalizedApiKey) {
    headers.authorization = `Bearer ${normalizedApiKey}`;
  }
  return headers;
}

function buildPath(path: string, query: QueryParameters | undefined): string {
  if (!query) {
    return path;
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function decodeJsonResponse<TResponse>(response: Response): Promise<TResponse> {
  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      if (response.ok) {
        throw new Error("EasyEmail returned a non-JSON success response.", { cause: error });
      }
    }
  }

  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string"
      ? payload.message
      : text || `EasyEmail HTTP request failed with status ${response.status}.`;
    const code = isRecord(payload) && typeof payload.code === "string"
      ? payload.code
      : isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : undefined;
    throw new EasyEmailHttpError(message, response.status, code);
  }

  return payload as TResponse;
}

export function createFetchJsonHttpClient(options: FetchJsonHttpClientOptions): JsonHttpClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("EasyEmail timeoutMs must be a positive finite number.");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A Fetch API implementation is required.");
  }
  const defaultHeaders = buildHeaders(options.apiKey);

  async function request<TResponse>(
    path: string,
    init: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<TResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          ...defaultHeaders,
          ...(init.headers ?? {}),
        },
        body: init.body,
        signal: controller.signal,
      });
      return await decodeJsonResponse<TResponse>(response);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new EasyEmailTimeoutError(timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get<TResponse>(path: string, query?: QueryParameters) {
      return request<TResponse>(buildPath(path, query), { method: "GET" });
    },
    post<TRequest, TResponse>(path: string, body: TRequest) {
      return request<TResponse>(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      });
    },
    put<TRequest, TResponse>(path: string, body: TRequest) {
      return request<TResponse>(path, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      });
    },
    patch<TRequest, TResponse>(path: string, body: TRequest) {
      return request<TResponse>(path, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      });
    },
    delete<TResponse>(path: string, query?: QueryParameters) {
      return request<TResponse>(buildPath(path, query), { method: "DELETE" });
    },
  };
}
