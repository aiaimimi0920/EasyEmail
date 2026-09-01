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

export type EasyEmailMailboxSessionStatus = "open" | "resolved" | "expired";
export type EasyEmailCodeSource = "subject" | "html" | "text";

export type EasyEmailMailboxSession = {
  id: string;
  hostId: string;
  providerTypeKey: string;
  providerInstanceId: string;
  emailAddress: string;
  mailboxRef: string;
  status: EasyEmailMailboxSessionStatus;
  createdAt: string;
  expiresAt?: string;
  metadata: Record<string, string>;
};

export type EasyEmailProviderInstance = {
  id: string;
  providerTypeKey: string;
  displayName: string;
  status: "active" | "cooling" | "provisioning" | "degraded" | "offline";
  runtimeKind: "external" | "cloudflare_temp_email-runtime";
  connectorKind: string;
  shared: boolean;
  costTier: "free" | "paid";
  healthScore: number;
  averageLatencyMs: number;
  connectionRef: string;
  hostBindings: string[];
  groupKeys: string[];
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type EasyEmailHostBinding = {
  hostId: string;
  providerTypeKey: string;
  bindingMode: "shared-instance" | "dedicated-instance" | "instance-group";
  instanceId: string;
  groupKey?: string;
  updatedAt: string;
};

export type EasyEmailTemporaryAuthCredential = {
  credentialType: string;
  fields: Record<string, string>;
  serverManaged: boolean;
  expiresAt?: string;
};

export type EasyEmailRecoveryRequiredFields = {
  evidenceStatus: "undetermined" | "verified";
  minimumHorizonDays: number;
  reason: string;
  fields: Record<string, string>;
  serverSidePrerequisites: string[];
};

export type EasyEmailCreatedByProvider = {
  providerTypeKey: string;
  providerInstanceId: string;
  displayName: string;
};

export type EasyEmailVerificationMailboxOpenResult = {
  session: EasyEmailMailboxSession;
  instance: EasyEmailProviderInstance;
  binding: EasyEmailHostBinding;
  temporaryAuthCredential: EasyEmailTemporaryAuthCredential;
  recoveryDataCredential: Record<string, string>;
  recoverabilityLevel: "unrecoverable" | "key_recoverable" | "recoverable";
  recoveryRequiredFields: EasyEmailRecoveryRequiredFields;
  createdByProvider: EasyEmailCreatedByProvider;
  runtimePlan?: Record<string, unknown>;
  strategyMode?: Record<string, unknown>;
  aliasOutcome?: Record<string, unknown>;
};

export type EasyEmailActionLinkCandidate = {
  url: string;
  label?: string;
  source: EasyEmailCodeSource;
};

export type EasyEmailObservedMessage = {
  id: string;
  sessionId: string;
  providerInstanceId: string;
  observedAt: string;
  sender?: string;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
  extractedCode?: string;
  extractedCandidates?: string[];
  codeSource?: EasyEmailCodeSource;
  actionLinks?: EasyEmailActionLinkCandidate[];
};

export type EasyEmailVerificationCodeResult = {
  sessionId: string;
  providerInstanceId: string;
  code: string;
  source: EasyEmailCodeSource;
  observedMessageId: string;
  receivedAt: string;
  candidates?: string[];
};

export type EasyEmailAuthenticationLinkResult = {
  sessionId: string;
  providerInstanceId: string;
  url: string;
  label?: string;
  source: EasyEmailCodeSource;
  observedMessageId: string;
  receivedAt: string;
  links?: EasyEmailActionLinkCandidate[];
};

export type EasyEmailCatalogResponse<TCatalog = unknown> = {
  catalog: TCatalog;
};

export type EasyEmailPlanMailboxResponse<TResult = unknown> = {
  plan: TResult;
};

export type EasyEmailOpenMailboxResponse<
  TResult = EasyEmailVerificationMailboxOpenResult,
> = {
  result: TResult;
};

export type EasyEmailMailboxSessionsResponse<
  TSession = EasyEmailMailboxSession,
> = {
  sessions: TSession[];
};

export type EasyEmailProviderInstancesResponse<
  TInstance = EasyEmailProviderInstance,
> = {
  instances: TInstance[];
};

export type EasyEmailObservedMessagesResponse<
  TMessage = EasyEmailObservedMessage,
> = {
  messages: TMessage[];
};

export type EasyEmailObservedMessageResponse<
  TMessage = EasyEmailObservedMessage,
> = {
  message?: TMessage;
};

export type EasyEmailVerificationCodeResponse<
  TResult = EasyEmailVerificationCodeResult,
> = {
  code?: TResult;
};

export type EasyEmailAuthenticationLinkResponse<
  TResult = EasyEmailAuthenticationLinkResult,
> = {
  authLink?: TResult;
};

export type EasyEmailReleaseMailboxResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailUpdateMailboxResponse<
  TSession = EasyEmailMailboxSession,
> = {
  session: TSession;
};

export type EasyEmailSendMailboxResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailRecoverMailboxResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailReportMailboxOutcomeResponse<TResult = unknown> = {
  result: TResult;
};

export type EasyEmailOpenMailboxRequest = {
  hostId: string;
  provisionMode: "reuse-only" | "auto-create-if-missing" | "always-create-dedicated";
  bindingMode: "shared-instance" | "dedicated-instance" | "instance-group";
  providerTypeKey?: string;
  providerRoutingProfileId?: string;
  excludedProviderTypeKeys?: string[];
  excludedDomains?: string[];
  excludedEmailAddresses?: string[];
  requestedDomain?: string;
  requestedLocalPart?: string;
  turnstileToken?: string;
  requestRandomSubdomain?: boolean;
  includeAliasEmail?: boolean;
  strategyProfileId?: string;
  providerStrategyModeId?: string;
  providerGroupSelections?: string[];
  preferredInstanceId?: string;
  runtimeTemplateId?: string;
  groupKey?: string;
  ttlMinutes?: number;
  recoverabilityLevels?: Array<"unrecoverable" | "key_recoverable" | "recoverable">;
  includeUndeterminedRecoverability?: boolean;
  metadata?: Record<string, string>;
};

export type EasyEmailMailboxSessionQuery = {
  hostId?: string;
  providerTypeKey?: string;
  providerInstanceId?: string;
  status?: EasyEmailMailboxSessionStatus;
  limit?: number;
  newestFirst?: boolean;
  [key: string]: string | number | boolean | null | undefined;
};

export type EasyEmailProviderInstanceQuery = {
  providerTypeKey?: string;
  status?: EasyEmailProviderInstance["status"];
  shared?: boolean;
  groupKey?: string;
  limit?: number;
  [key: string]: string | number | boolean | null | undefined;
};

export type EasyEmailObservedMessageQuery = {
  sessionId?: string;
  providerInstanceId?: string;
  extractedCodeOnly?: boolean;
  sync?: boolean;
  newestFirst?: boolean;
  limit?: number;
  [key: string]: string | number | boolean | null | undefined;
};

export type EasyEmailMailboxUpdateRequest = {
  sessionId: string;
  fromContains?: string;
  metadata?: Record<string, string>;
};

export type EasyEmailMailboxSendRequest = {
  sessionId: string;
  toEmailAddress: string;
  toName?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  fromName?: string;
};

export type EasyEmailRecoverMailboxRequest = {
  emailAddress?: string;
  providerTypeKey?: string;
  providerInstanceId?: string;
  hostId?: string;
  recoveryDataCredential?: Record<string, string>;
  recoveryFields?: Record<string, string>;
};

export type EasyEmailMailboxOutcomeRequest = {
  sessionId: string;
  success: boolean;
  failureReason?: string;
  observedAt?: string;
  registrationMode?: string;
  source?: string;
  businessFlow?: string;
  retryLayer?: "step" | "chain" | "attempt";
};

export const EASY_EMAIL_CORE_ROUTES = {
  catalog: "/mail/catalog",
  planMailbox: "/mail/mailboxes/plan",
  openMailbox: "/mail/mailboxes/open",
  queryProviderInstances: "/mail/query/provider-instances",
  queryMailboxSessions: "/mail/query/mailbox-sessions",
  queryObservedMessages: "/mail/query/observed-messages",
  updateMailbox: "/mail/mailboxes/update-session",
  releaseMailbox: "/mail/mailboxes/release",
  recoverMailbox: "/mail/mailboxes/recover-by-email",
  reportMailboxOutcome: "/mail/mailboxes/report-outcome",
  sendMailboxMessage: "/mail/mailboxes/send",
  verificationCode(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/code`;
  },
  authenticationLink(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/auth-link`;
  },
  observedMessage(messageId: string): string {
    return `/mail/query/observed-messages/${encodeURIComponent(messageId)}`;
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
    planMailbox<TResult = unknown>(
      mailboxRequest: EasyEmailOpenMailboxRequest,
    ): Promise<EasyEmailPlanMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.planMailbox,
        body: mailboxRequest,
      });
    },
    openMailbox<TResult = EasyEmailVerificationMailboxOpenResult>(
      mailboxRequest: EasyEmailOpenMailboxRequest,
    ): Promise<EasyEmailOpenMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.openMailbox,
        body: mailboxRequest,
      });
    },
    queryProviderInstances<TInstance = EasyEmailProviderInstance>(
      query: EasyEmailProviderInstanceQuery = {},
    ): Promise<EasyEmailProviderInstancesResponse<TInstance>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.queryProviderInstances, query });
    },
    queryMailboxSessions<TSession = EasyEmailMailboxSession>(
      query: EasyEmailMailboxSessionQuery,
    ): Promise<EasyEmailMailboxSessionsResponse<TSession>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.queryMailboxSessions, query });
    },
    queryObservedMessages<TMessage = EasyEmailObservedMessage>(
      query: EasyEmailObservedMessageQuery,
    ): Promise<EasyEmailObservedMessagesResponse<TMessage>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.queryObservedMessages, query });
    },
    getObservedMessage<TMessage = EasyEmailObservedMessage>(
      messageId: string,
    ): Promise<EasyEmailObservedMessageResponse<TMessage>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.observedMessage(messageId) });
    },
    readVerificationCode<TResult = EasyEmailVerificationCodeResult>(
      sessionId: string,
    ): Promise<EasyEmailVerificationCodeResponse<TResult>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.verificationCode(sessionId) });
    },
    readAuthenticationLink<TResult = EasyEmailAuthenticationLinkResult>(
      sessionId: string,
    ): Promise<EasyEmailAuthenticationLinkResponse<TResult>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.authenticationLink(sessionId) });
    },
    updateMailbox<TSession = EasyEmailMailboxSession>(
      updateRequest: EasyEmailMailboxUpdateRequest,
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
    recoverMailbox<TResult = unknown>(
      recoverRequest: EasyEmailRecoverMailboxRequest,
    ): Promise<EasyEmailRecoverMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.recoverMailbox,
        body: recoverRequest,
      });
    },
    reportMailboxOutcome<TResult = unknown>(
      outcomeRequest: EasyEmailMailboxOutcomeRequest,
    ): Promise<EasyEmailReportMailboxOutcomeResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.reportMailboxOutcome,
        body: outcomeRequest,
      });
    },
    sendMailboxMessage<TResult = unknown>(
      sendRequest: EasyEmailMailboxSendRequest,
    ): Promise<EasyEmailSendMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.sendMailboxMessage,
        body: sendRequest,
      });
    },
  };
}
