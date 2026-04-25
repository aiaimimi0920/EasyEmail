import {
  EASY_EMAIL_HTTP_ROUTES,
  type GetMailCatalogHttpResponse,
  type OpenMailboxHttpResponse,
  type PlanMailboxHttpResponse,
  type ReadAuthenticationLinkHttpResponse,
  type ReadVerificationCodeHttpResponse,
  type ReportMailboxOutcomeHttpResponse,
} from "../http/contracts.js";
import type {
  AuthenticationLinkResult,
  EasyEmailCatalog,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  VerificationCodeResult,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "../domain/models.js";

export interface FetchJsonHttpClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface JsonHttpClient {
  get<TResponse>(path: string): Promise<TResponse>;
  post<TRequest, TResponse>(path: string, body: TRequest): Promise<TResponse>;
}

export interface VerificationInboxClient {
  getCatalog(): Promise<EasyEmailCatalog>;
  planMailbox(request: VerificationMailboxRequest): Promise<PlanMailboxHttpResponse["plan"]>;
  openMailbox(request: VerificationMailboxRequest): Promise<VerificationMailboxOpenResult>;
  readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined>;
  readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined>;
  reportMailboxOutcome(report: MailboxOutcomeReport): Promise<MailboxOutcomeReportResult>;
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim();
  return normalized.replace(/\/+$/, "");
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };

  if (apiKey?.trim()) {
    headers.authorization = `Bearer ${apiKey.trim()}`;
  }

  return headers;
}

function mergeHeaders(
  defaults: Record<string, string>,
  next: Record<string, string> | undefined,
): Record<string, string> {
  if (!next) {
    return { ...defaults };
  }
  return {
    ...defaults,
    ...next,
  };
}

async function decodeJsonResponse<TResponse>(response: Response): Promise<TResponse> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) as TResponse : {} as TResponse;

  if (!response.ok) {
    const message = typeof payload === "object" && payload && "message" in (payload as Record<string, unknown>)
      ? String((payload as Record<string, unknown>).message ?? "")
      : text;
    throw new Error(message || `EasyEmail HTTP request failed with status ${response.status}.`);
  }

  return payload;
}

export function createFetchJsonHttpClient(options: FetchJsonHttpClientOptions): JsonHttpClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const defaultHeaders = buildHeaders(options.apiKey);

  async function request<TResponse>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<TResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers: mergeHeaders(defaultHeaders, init.headers),
        body: init.body,
        signal: controller.signal,
      });
      return await decodeJsonResponse<TResponse>(response);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`EasyEmail HTTP request timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get<TResponse>(path: string) {
      return request<TResponse>(path, {
        method: "GET",
      });
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
  };
}

export class HttpVerificationInboxClient implements VerificationInboxClient {
  public constructor(private readonly httpClient: JsonHttpClient) {}

  public async getCatalog(): Promise<EasyEmailCatalog> {
    const response = await this.httpClient.get<GetMailCatalogHttpResponse>(EASY_EMAIL_HTTP_ROUTES.catalog);
    return response.catalog;
  }

  public async planMailbox(request: VerificationMailboxRequest): Promise<PlanMailboxHttpResponse["plan"]> {
    const response = await this.httpClient.post<VerificationMailboxRequest, PlanMailboxHttpResponse>(
      EASY_EMAIL_HTTP_ROUTES.planMailbox,
      request,
    );
    return response.plan;
  }

  public async openMailbox(request: VerificationMailboxRequest): Promise<VerificationMailboxOpenResult> {
    const response = await this.httpClient.post<VerificationMailboxRequest, OpenMailboxHttpResponse>(
      EASY_EMAIL_HTTP_ROUTES.openMailbox,
      request,
    );
    return response.result;
  }

  public async readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined> {
    const response = await this.httpClient.get<ReadVerificationCodeHttpResponse>(
      EASY_EMAIL_HTTP_ROUTES.readVerificationCode(sessionId),
    );
    return response.code;
  }

  public async readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined> {
    const response = await this.httpClient.get<ReadAuthenticationLinkHttpResponse>(
      EASY_EMAIL_HTTP_ROUTES.readAuthenticationLink(sessionId),
    );
    return response.authLink;
  }

  public async reportMailboxOutcome(report: MailboxOutcomeReport): Promise<MailboxOutcomeReportResult> {
    const response = await this.httpClient.post<MailboxOutcomeReport, ReportMailboxOutcomeHttpResponse>(
      EASY_EMAIL_HTTP_ROUTES.reportMailboxOutcome,
      report,
    );
    return response.result;
  }
}
