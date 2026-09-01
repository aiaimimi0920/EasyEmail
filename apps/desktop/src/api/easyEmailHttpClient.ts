export type EasyEmailHttpQuery = Record<
  string,
  string | number | boolean | null | undefined
>;

export type EasyEmailHttpRequest = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: EasyEmailHttpQuery;
  body?: unknown;
  signal?: AbortSignal;
};

export type EasyEmailHttpClientOptions = {
  baseUrl: string;
  bearerToken?: string;
  fetch?: typeof fetch;
};

export type EasyEmailCatalogResponse<TCatalog = unknown> = {
  catalog: TCatalog;
};

export type EasyEmailOpenMailboxResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailObservedMessagesResponse<TMessage = unknown> = {
  messages: TMessage[];
};

export type EasyEmailVerificationCodeResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailAuthenticationLinkResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailReleaseMailboxResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailUpdateMailboxResponse<TSession = unknown> = {
  session: TSession;
};

export type EasyEmailSendMailboxResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailOpenMailboxRequest = {
  hostId: string;
  provisionMode: string;
  bindingMode: string;
  providerTypeKey?: string;
  requestedDomain?: string;
  requestedLocalPart?: string;
  [key: string]: unknown;
};

export type EasyEmailObservedMessageQuery = {
  sessionId?: string;
  providerInstanceId?: string;
  sync?: boolean;
  newestFirst?: boolean;
  limit?: number;
  [key: string]: string | number | boolean | null | undefined;
};

export const EASY_EMAIL_CORE_ROUTES = {
  catalog: "/mail/catalog",
  openMailbox: "/mail/mailboxes/open",
  queryObservedMessages: "/mail/query/observed-messages",
  updateMailbox: "/mail/mailboxes/update-session",
  releaseMailbox: "/mail/mailboxes/release",
  sendMailboxMessage: "/mail/mailboxes/send",
  verificationCode(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/code`;
  },
  authenticationLink(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/auth-link`;
  },
} as const;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
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

export function createEasyEmailHttpClient(options: EasyEmailHttpClientOptions) {
  const baseUrl = normalizeEasyEmailHttpBaseUrl(options.baseUrl);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  if (typeof fetchRequest !== "function") {
    throw new Error("EasyEmail HTTP transport requires fetch.");
  }

  async function request<T>(requestOptions: EasyEmailHttpRequest): Promise<T> {
    const hasBody = requestOptions.body !== undefined;
    const headers = new Headers({ accept: "application/json" });
    if (hasBody) headers.set("content-type", "application/json");
    if (options.bearerToken) {
      headers.set("authorization", `Bearer ${options.bearerToken}`);
    }

    const response = await fetchRequest(
      buildRequestUrl(baseUrl, requestOptions.path, requestOptions.query),
      {
        method: requestOptions.method ?? "GET",
        headers,
        body: hasBody ? JSON.stringify(requestOptions.body) : undefined,
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
  }

  return {
    request,
    getCatalog<TCatalog = unknown>(): Promise<EasyEmailCatalogResponse<TCatalog>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.catalog });
    },
    openMailbox<TResult = unknown>(
      mailboxRequest: EasyEmailOpenMailboxRequest,
    ): Promise<EasyEmailOpenMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.openMailbox,
        body: mailboxRequest,
      });
    },
    queryObservedMessages<TMessage = unknown>(
      query: EasyEmailObservedMessageQuery,
    ): Promise<EasyEmailObservedMessagesResponse<TMessage>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.queryObservedMessages, query });
    },
    readVerificationCode<TResult = unknown>(
      sessionId: string,
    ): Promise<EasyEmailVerificationCodeResponse<TResult>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.verificationCode(sessionId) });
    },
    readAuthenticationLink<TResult = unknown>(
      sessionId: string,
    ): Promise<EasyEmailAuthenticationLinkResponse<TResult>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.authenticationLink(sessionId) });
    },
    updateMailbox<TSession = unknown>(
      updateRequest: Record<string, unknown>,
    ): Promise<EasyEmailUpdateMailboxResponse<TSession>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.updateMailbox,
        body: updateRequest,
      });
    },
    releaseMailbox<TResult = unknown>(
      releaseRequest: { sessionId: string; reason?: string },
    ): Promise<EasyEmailReleaseMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.releaseMailbox,
        body: releaseRequest,
      });
    },
    sendMailboxMessage<TResult = unknown>(
      sendRequest: Record<string, unknown>,
    ): Promise<EasyEmailSendMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.sendMailboxMessage,
        body: sendRequest,
      });
    },
  };
}
