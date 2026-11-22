import type * as Contracts from "./contracts.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  createFetchJsonHttpClient,
} from "./http-transport.js";
import type {
  FetchJsonHttpClientOptions,
  JsonHttpClient,
} from "./http-transport.js";

export interface EasyEmailMailboxClientApi {
  getCatalog(): Promise<Contracts.EasyEmailCatalog>;
  getSnapshot(): Promise<Contracts.EasyEmailSnapshot>;
  planMailbox(request: Contracts.VerificationMailboxRequest): Promise<Contracts.MailboxPlanResult>;
  openMailbox(request: Contracts.VerificationMailboxRequest): Promise<Contracts.VerificationMailboxOpenResult>;
  sendMailboxMessage(request: Contracts.MailboxSendRequest): Promise<Contracts.MailboxSendResult>;
  updateMailboxSession(request: Contracts.MailboxSessionUpdateRequest): Promise<Contracts.MailboxSession>;
  releaseMailbox(request: Contracts.ReleaseMailboxRequest): Promise<Contracts.ReleaseMailboxResult>;
  recoverMailboxByEmail(request: Contracts.RecoverMailboxByEmailRequest): Promise<Contracts.RecoverMailboxByEmailResult>;
  recoverMailboxCapacity(request: Contracts.RecoverMailboxCapacityRequest): Promise<Contracts.RecoverMailboxCapacityResult>;
  readVerificationCode(sessionId: string): Promise<Contracts.VerificationCodeResult | undefined>;
  readAuthenticationLink(sessionId: string): Promise<Contracts.AuthenticationLinkResult | undefined>;
  reportMailboxOutcome(report: Contracts.MailboxOutcomeReport): Promise<Contracts.MailboxOutcomeReportResult>;
  observeMessage(input: Contracts.ObserveMessageInput): Promise<Contracts.ObservedMessage>;
  listObservedMessages(filters?: Contracts.ObservedMessageQueryFilters): Promise<Contracts.ObservedMessage[]>;
  getObservedMessage(messageId: string): Promise<Contracts.ObservedMessage | undefined>;
}

export class EasyEmailMailboxClientBase implements EasyEmailMailboxClientApi {
  protected readonly httpClient: JsonHttpClient;

  public constructor(options: FetchJsonHttpClientOptions | JsonHttpClient) {
    this.httpClient = "baseUrl" in options
      ? createFetchJsonHttpClient(options)
      : options;
  }

  public async getCatalog(): Promise<Contracts.EasyEmailCatalog> {
    const response = await this.httpClient.get<{ catalog: Contracts.EasyEmailCatalog }>(
      EASY_EMAIL_HTTP_ROUTES.catalog,
    );
    return response.catalog;
  }

  public async getSnapshot(): Promise<Contracts.EasyEmailSnapshot> {
    const response = await this.httpClient.get<{ snapshot: Contracts.EasyEmailSnapshot }>(
      EASY_EMAIL_HTTP_ROUTES.snapshot,
    );
    return response.snapshot;
  }

  public async planMailbox(
    request: Contracts.VerificationMailboxRequest,
  ): Promise<Contracts.MailboxPlanResult> {
    const response = await this.httpClient.post<
      Contracts.VerificationMailboxRequest,
      { plan: Contracts.MailboxPlanResult }
    >(EASY_EMAIL_HTTP_ROUTES.planMailbox, request);
    return response.plan;
  }

  public async openMailbox(
    request: Contracts.VerificationMailboxRequest,
  ): Promise<Contracts.VerificationMailboxOpenResult> {
    const response = await this.httpClient.post<
      Contracts.VerificationMailboxRequest,
      { result: Contracts.VerificationMailboxOpenResult }
    >(EASY_EMAIL_HTTP_ROUTES.openMailbox, request);
    return response.result;
  }

  public async sendMailboxMessage(
    request: Contracts.MailboxSendRequest,
  ): Promise<Contracts.MailboxSendResult> {
    const response = await this.httpClient.post<
      Contracts.MailboxSendRequest,
      { result: Contracts.MailboxSendResult }
    >(EASY_EMAIL_HTTP_ROUTES.sendMailboxMessage, request);
    return response.result;
  }

  public async updateMailboxSession(
    request: Contracts.MailboxSessionUpdateRequest,
  ): Promise<Contracts.MailboxSession> {
    const response = await this.httpClient.post<
      Contracts.MailboxSessionUpdateRequest,
      { session: Contracts.MailboxSession }
    >(EASY_EMAIL_HTTP_ROUTES.updateMailboxSession, request);
    return response.session;
  }

  public async releaseMailbox(
    request: Contracts.ReleaseMailboxRequest,
  ): Promise<Contracts.ReleaseMailboxResult> {
    const response = await this.httpClient.post<
      Contracts.ReleaseMailboxRequest,
      { result: Contracts.ReleaseMailboxResult }
    >(EASY_EMAIL_HTTP_ROUTES.releaseMailbox, request);
    return response.result;
  }

  public async recoverMailboxByEmail(
    request: Contracts.RecoverMailboxByEmailRequest,
  ): Promise<Contracts.RecoverMailboxByEmailResult> {
    const response = await this.httpClient.post<
      Contracts.RecoverMailboxByEmailRequest,
      { result: Contracts.RecoverMailboxByEmailResult }
    >(EASY_EMAIL_HTTP_ROUTES.recoverMailboxByEmail, request);
    return response.result;
  }

  public async recoverMailboxCapacity(
    request: Contracts.RecoverMailboxCapacityRequest,
  ): Promise<Contracts.RecoverMailboxCapacityResult> {
    const response = await this.httpClient.post<
      Contracts.RecoverMailboxCapacityRequest,
      { result: Contracts.RecoverMailboxCapacityResult }
    >(EASY_EMAIL_HTTP_ROUTES.recoverMailboxCapacity, request);
    return response.result;
  }

  public async readVerificationCode(
    sessionId: string,
  ): Promise<Contracts.VerificationCodeResult | undefined> {
    const response = await this.httpClient.get<{ code?: Contracts.VerificationCodeResult }>(
      EASY_EMAIL_HTTP_ROUTES.readVerificationCode(sessionId),
    );
    return response.code;
  }

  public async readAuthenticationLink(
    sessionId: string,
  ): Promise<Contracts.AuthenticationLinkResult | undefined> {
    const response = await this.httpClient.get<{ authLink?: Contracts.AuthenticationLinkResult }>(
      EASY_EMAIL_HTTP_ROUTES.readAuthenticationLink(sessionId),
    );
    return response.authLink;
  }

  public async reportMailboxOutcome(
    report: Contracts.MailboxOutcomeReport,
  ): Promise<Contracts.MailboxOutcomeReportResult> {
    const response = await this.httpClient.post<
      Contracts.MailboxOutcomeReport,
      { result: Contracts.MailboxOutcomeReportResult }
    >(EASY_EMAIL_HTTP_ROUTES.reportMailboxOutcome, report);
    return response.result;
  }

  public async observeMessage(input: Contracts.ObserveMessageInput): Promise<Contracts.ObservedMessage> {
    const response = await this.httpClient.post<
      Contracts.ObserveMessageInput,
      { message: Contracts.ObservedMessage }
    >(EASY_EMAIL_HTTP_ROUTES.observeMessage, input);
    return response.message;
  }

  public async listObservedMessages(
    filters: Contracts.ObservedMessageQueryFilters = {},
  ): Promise<Contracts.ObservedMessage[]> {
    const response = await this.httpClient.get<{ messages: Contracts.ObservedMessage[] }>(
      EASY_EMAIL_HTTP_ROUTES.queryObservedMessages,
      filters,
    );
    return response.messages;
  }

  public async getObservedMessage(messageId: string): Promise<Contracts.ObservedMessage | undefined> {
    const response = await this.httpClient.get<{ message?: Contracts.ObservedMessage }>(
      EASY_EMAIL_HTTP_ROUTES.getObservedMessage(messageId),
    );
    return response.message;
  }
}
