import type {
  AuthenticationLinkResult,
  Contact,
  ContactCreateInput,
  ContactListQuery,
  ContactListResult,
  ContactUpdateInput,
  EasyEmailCatalog,
  EasyEmailSnapshot,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxPlanResult,
  MailboxSendRequest,
  MailboxSendResult,
  MailboxSession,
  MailboxSessionUpdateRequest,
  ObserveMessageInput,
  ObservedMessage,
  ObservedMessageQueryFilters,
  RecoverMailboxByEmailRequest,
  RecoverMailboxByEmailResult,
  RecoverMailboxCapacityRequest,
  RecoverMailboxCapacityResult,
  ReleaseMailboxRequest,
  ReleaseMailboxResult,
  VerificationCodeResult,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "./contracts.js";

export const EASY_EMAIL_HTTP_ROUTES = {
  catalog: "/mail/catalog",
  snapshot: "/mail/snapshot",
  queryObservedMessages: "/mail/query/observed-messages",
  contacts: "/mail/contacts",
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
      method: "GET" | "POST" | "PATCH" | "DELETE";
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

export interface EasyEmailClientApi {
  getCatalog(): Promise<EasyEmailCatalog>;
  getSnapshot(): Promise<EasyEmailSnapshot>;
  listContacts(query?: ContactListQuery): Promise<ContactListResult>;
  getContact(contactId: string): Promise<Contact>;
  createContact(input: ContactCreateInput): Promise<Contact>;
  updateContact(contactId: string, input: ContactUpdateInput): Promise<Contact>;
  deleteContact(contactId: string, expectedVersion: number): Promise<{ id: string }>;
  planMailbox(request: VerificationMailboxRequest): Promise<MailboxPlanResult>;
  openMailbox(request: VerificationMailboxRequest): Promise<VerificationMailboxOpenResult>;
  sendMailboxMessage(request: MailboxSendRequest): Promise<MailboxSendResult>;
  updateMailboxSession(request: MailboxSessionUpdateRequest): Promise<MailboxSession>;
  releaseMailbox(request: ReleaseMailboxRequest): Promise<ReleaseMailboxResult>;
  recoverMailboxByEmail(request: RecoverMailboxByEmailRequest): Promise<RecoverMailboxByEmailResult>;
  recoverMailboxCapacity(request: RecoverMailboxCapacityRequest): Promise<RecoverMailboxCapacityResult>;
  readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined>;
  readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined>;
  reportMailboxOutcome(report: MailboxOutcomeReport): Promise<MailboxOutcomeReportResult>;
  observeMessage(input: ObserveMessageInput): Promise<ObservedMessage>;
  listObservedMessages(filters?: ObservedMessageQueryFilters): Promise<ObservedMessage[]>;
  getObservedMessage(messageId: string): Promise<ObservedMessage | undefined>;
}

export class EasyEmailClient implements EasyEmailClientApi {
  private readonly httpClient: JsonHttpClient;

  public constructor(options: FetchJsonHttpClientOptions | JsonHttpClient) {
    this.httpClient = "baseUrl" in options
      ? createFetchJsonHttpClient(options)
      : options;
  }

  public async getCatalog(): Promise<EasyEmailCatalog> {
    const response = await this.httpClient.get<{ catalog: EasyEmailCatalog }>(EASY_EMAIL_HTTP_ROUTES.catalog);
    return response.catalog;
  }

  public async getSnapshot(): Promise<EasyEmailSnapshot> {
    const response = await this.httpClient.get<{ snapshot: EasyEmailSnapshot }>(EASY_EMAIL_HTTP_ROUTES.snapshot);
    return response.snapshot;
  }

  public async listContacts(query: ContactListQuery = {}): Promise<ContactListResult> {
    return this.httpClient.get<ContactListResult>(EASY_EMAIL_HTTP_ROUTES.contacts, {
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async getContact(contactId: string): Promise<Contact> {
    const response = await this.httpClient.get<{ contact: Contact }>(
      EASY_EMAIL_HTTP_ROUTES.contact(contactId),
    );
    return response.contact;
  }

  public async createContact(input: ContactCreateInput): Promise<Contact> {
    const response = await this.httpClient.post<ContactCreateInput, { contact: Contact }>(
      EASY_EMAIL_HTTP_ROUTES.contacts,
      input,
    );
    return response.contact;
  }

  public async updateContact(contactId: string, input: ContactUpdateInput): Promise<Contact> {
    const response = await this.httpClient.patch<ContactUpdateInput, { contact: Contact }>(
      EASY_EMAIL_HTTP_ROUTES.contact(contactId),
      input,
    );
    return response.contact;
  }

  public async deleteContact(contactId: string, expectedVersion: number): Promise<{ id: string }> {
    const response = await this.httpClient.delete<{ deleted: { id: string } }>(
      EASY_EMAIL_HTTP_ROUTES.contact(contactId),
      { expectedVersion },
    );
    return response.deleted;
  }

  public async planMailbox(request: VerificationMailboxRequest): Promise<MailboxPlanResult> {
    const response = await this.httpClient.post<VerificationMailboxRequest, { plan: MailboxPlanResult }>(
      EASY_EMAIL_HTTP_ROUTES.planMailbox,
      request,
    );
    return response.plan;
  }

  public async openMailbox(request: VerificationMailboxRequest): Promise<VerificationMailboxOpenResult> {
    const response = await this.httpClient.post<VerificationMailboxRequest, { result: VerificationMailboxOpenResult }>(
      EASY_EMAIL_HTTP_ROUTES.openMailbox,
      request,
    );
    return response.result;
  }

  public async sendMailboxMessage(request: MailboxSendRequest): Promise<MailboxSendResult> {
    const response = await this.httpClient.post<MailboxSendRequest, { result: MailboxSendResult }>(
      EASY_EMAIL_HTTP_ROUTES.sendMailboxMessage,
      request,
    );
    return response.result;
  }

  public async updateMailboxSession(request: MailboxSessionUpdateRequest): Promise<MailboxSession> {
    const response = await this.httpClient.post<MailboxSessionUpdateRequest, { session: MailboxSession }>(
      EASY_EMAIL_HTTP_ROUTES.updateMailboxSession,
      request,
    );
    return response.session;
  }

  public async releaseMailbox(request: ReleaseMailboxRequest): Promise<ReleaseMailboxResult> {
    const response = await this.httpClient.post<ReleaseMailboxRequest, { result: ReleaseMailboxResult }>(
      EASY_EMAIL_HTTP_ROUTES.releaseMailbox,
      request,
    );
    return response.result;
  }

  public async recoverMailboxByEmail(request: RecoverMailboxByEmailRequest): Promise<RecoverMailboxByEmailResult> {
    const response = await this.httpClient.post<RecoverMailboxByEmailRequest, { result: RecoverMailboxByEmailResult }>(
      EASY_EMAIL_HTTP_ROUTES.recoverMailboxByEmail,
      request,
    );
    return response.result;
  }

  public async recoverMailboxCapacity(request: RecoverMailboxCapacityRequest): Promise<RecoverMailboxCapacityResult> {
    const response = await this.httpClient.post<RecoverMailboxCapacityRequest, { result: RecoverMailboxCapacityResult }>(
      EASY_EMAIL_HTTP_ROUTES.recoverMailboxCapacity,
      request,
    );
    return response.result;
  }

  public async readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined> {
    const response = await this.httpClient.get<{ code?: VerificationCodeResult }>(
      EASY_EMAIL_HTTP_ROUTES.readVerificationCode(sessionId),
    );
    return response.code;
  }

  public async readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined> {
    const response = await this.httpClient.get<{ authLink?: AuthenticationLinkResult }>(
      EASY_EMAIL_HTTP_ROUTES.readAuthenticationLink(sessionId),
    );
    return response.authLink;
  }

  public async reportMailboxOutcome(report: MailboxOutcomeReport): Promise<MailboxOutcomeReportResult> {
    const response = await this.httpClient.post<MailboxOutcomeReport, { result: MailboxOutcomeReportResult }>(
      EASY_EMAIL_HTTP_ROUTES.reportMailboxOutcome,
      report,
    );
    return response.result;
  }

  public async observeMessage(input: ObserveMessageInput): Promise<ObservedMessage> {
    const response = await this.httpClient.post<ObserveMessageInput, { message: ObservedMessage }>(
      EASY_EMAIL_HTTP_ROUTES.observeMessage,
      input,
    );
    return response.message;
  }

  public async listObservedMessages(filters: ObservedMessageQueryFilters = {}): Promise<ObservedMessage[]> {
    const response = await this.httpClient.get<{ messages: ObservedMessage[] }>(
      EASY_EMAIL_HTTP_ROUTES.queryObservedMessages,
      filters,
    );
    return response.messages;
  }

  public async getObservedMessage(messageId: string): Promise<ObservedMessage | undefined> {
    const response = await this.httpClient.get<{ message?: ObservedMessage }>(
      EASY_EMAIL_HTTP_ROUTES.getObservedMessage(messageId),
    );
    return response.message;
  }
}
