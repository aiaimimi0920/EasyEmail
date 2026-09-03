import type {
  EasyEmailHttpQuery,
  EasyEmailHttpRequest,
  EasyEmailHttpClientOptions,
  EasyEmailMailboxSession,
  EasyEmailProviderInstance,
  EasyEmailVerificationMailboxOpenResult,
  EasyEmailObservedMessage,
  EasyEmailVerificationCodeResult,
  EasyEmailAuthenticationLinkResult,
  EasyEmailCatalogResponse,
  EasyEmailContact,
  EasyEmailContactCreateRequest,
  EasyEmailContactUpdateRequest,
  EasyEmailContactListQuery,
  EasyEmailContactsResponse,
  EasyEmailContactResponse,
  EasyEmailContactDeleteResponse,
} from "./easyEmailCoreTypes.ts";

export type {
  EasyEmailHttpQuery,
  EasyEmailHttpRequest,
  EasyEmailHttpClientOptions,
  EasyEmailMailboxSessionStatus,
  EasyEmailCodeSource,
  EasyEmailMailboxSession,
  EasyEmailProviderInstance,
  EasyEmailHostBinding,
  EasyEmailTemporaryAuthCredential,
  EasyEmailRecoveryRequiredFields,
  EasyEmailCreatedByProvider,
  EasyEmailVerificationMailboxOpenResult,
  EasyEmailActionLinkCandidate,
  EasyEmailObservedMessage,
  EasyEmailVerificationCodeResult,
  EasyEmailAuthenticationLinkResult,
  EasyEmailCatalogResponse,
  EasyEmailContact,
  EasyEmailContactCreateRequest,
  EasyEmailContactUpdateRequest,
  EasyEmailContactListQuery,
  EasyEmailContactsResponse,
  EasyEmailContactResponse,
  EasyEmailContactDeleteResponse,
} from "./easyEmailCoreTypes.ts";

import type {
  EasyEmailMailAccountListQuery,
  EasyEmailMailAccountCreateRequest,
  EasyEmailMailAccountUpdateRequest,
  EasyEmailMailAccountsResponse,
  EasyEmailMailAccountResponse,
  EasyEmailMailAccountImapTestRequest,
  EasyEmailMailAccountImapTestResponse,
  EasyEmailMailTaxonomyKind,
  EasyEmailMailTaxonomyListQuery,
  EasyEmailMailTaxonomyListResponse,
  EasyEmailMailTaxonomyUpsertRequest,
  EasyEmailMailTaxonomyUpdateRequest,
  EasyEmailMailTaxonomyMutationResponse,
  EasyEmailMailTaxonomyDeleteResponse,
} from "./easyEmailMailTypes.ts";

export type {
  EasyEmailMailAccountScope,
  EasyEmailMailAccountKind,
  EasyEmailMailAccountCreatableKind,
  EasyEmailMailAccountImapSecurity,
  EasyEmailMailAccountImapProfile,
  EasyEmailMailAccountImapProfileInput,
  EasyEmailMailAccountStatus,
  EasyEmailMailAccountAuthStatus,
  EasyEmailMailAccountReceiveStatus,
  EasyEmailMailAccountSendStatus,
  EasyEmailMailAccount,
  EasyEmailMailAccountListQuery,
  EasyEmailMailAccountCreateRequest,
  EasyEmailMailAccountUpdateRequest,
  EasyEmailMailAccountsResponse,
  EasyEmailMailAccountResponse,
  EasyEmailMailAccountImapTestRequest,
  EasyEmailMailAccountImapTestResponse,
  EasyEmailMailTaxonomyKind,
  EasyEmailMailTaxonomyItem,
  EasyEmailMailTaxonomyCapabilities,
  EasyEmailMailTaxonomyListQuery,
  EasyEmailMailTaxonomyListResponse,
  EasyEmailMailTaxonomyUpsertRequest,
  EasyEmailMailTaxonomyUpdateRequest,
  EasyEmailMailTaxonomyMutationResponse,
  EasyEmailMailTaxonomyDeleteResponse,
} from "./easyEmailMailTypes.ts";

import type {
  EasyEmailPlanMailboxResponse,
  EasyEmailOpenMailboxResponse,
  EasyEmailMailboxSessionsResponse,
  EasyEmailProviderInstancesResponse,
  EasyEmailObservedMessagesResponse,
  EasyEmailObservedMessageResponse,
  EasyEmailVerificationCodeResponse,
  EasyEmailAuthenticationLinkResponse,
  EasyEmailMailboxRefreshResponse,
  EasyEmailReleaseMailboxResult,
  EasyEmailReleaseMailboxResponse,
  EasyEmailUpdateMailboxResponse,
  EasyEmailMailboxSendResult,
  EasyEmailSendMailboxResponse,
  EasyEmailRecoverMailboxResult,
  EasyEmailRecoverMailboxResponse,
  EasyEmailMailboxOutcomeResult,
  EasyEmailReportMailboxOutcomeResponse,
  EasyEmailOpenMailboxRequest,
  EasyEmailMailboxSessionQuery,
  EasyEmailProviderInstanceQuery,
  EasyEmailObservedMessageQuery,
  EasyEmailMailboxUpdateRequest,
  EasyEmailMailboxSendRequest,
  EasyEmailRecoverMailboxRequest,
  EasyEmailMailboxOutcomeRequest,
} from "./easyEmailMailboxTypes.ts";

export type {
  EasyEmailPlanMailboxResponse,
  EasyEmailOpenMailboxResponse,
  EasyEmailMailboxSessionsResponse,
  EasyEmailProviderInstancesResponse,
  EasyEmailObservedMessagesResponse,
  EasyEmailObservedMessageResponse,
  EasyEmailVerificationCodeResponse,
  EasyEmailAuthenticationLinkResponse,
  EasyEmailMailboxRefreshFailure,
  EasyEmailMailboxRefreshResult,
  EasyEmailMailboxRefreshResponse,
  EasyEmailReleaseMailboxResult,
  EasyEmailReleaseMailboxResponse,
  EasyEmailUpdateMailboxResponse,
  EasyEmailMailboxSendResult,
  EasyEmailSendMailboxResponse,
  EasyEmailRecoverMailboxResult,
  EasyEmailRecoverMailboxResponse,
  EasyEmailMailboxOutcomeResult,
  EasyEmailReportMailboxOutcomeResponse,
  EasyEmailOpenMailboxRequest,
  EasyEmailMailboxSessionQuery,
  EasyEmailProviderInstanceQuery,
  EasyEmailObservedMessageQuery,
  EasyEmailMailboxUpdateRequest,
  EasyEmailMailboxSendRequest,
  EasyEmailRecoverMailboxRequest,
  EasyEmailMailboxOutcomeRequest,
} from "./easyEmailMailboxTypes.ts";

import { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";

export { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";

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
  const bearerToken = options.bearerToken?.trim();
  const fetchRequest = options.fetch ?? globalThis.fetch;
  if (typeof fetchRequest !== "function") {
    throw new Error("EasyEmail HTTP transport requires fetch.");
  }

  async function request<T>(requestOptions: EasyEmailHttpRequest): Promise<T> {
    const hasBody = requestOptions.body !== undefined;
    const headers = new Headers({ accept: "application/json" });
    if (hasBody) headers.set("content-type", "application/json");
    if (bearerToken) {
      headers.set("authorization", `Bearer ${bearerToken}`);
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
    listContacts<TContact = EasyEmailContact>(
      query: EasyEmailContactListQuery = {},
    ): Promise<EasyEmailContactsResponse<TContact>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.contacts, query });
    },
    createContact<TContact = EasyEmailContact>(
      contactRequest: EasyEmailContactCreateRequest,
    ): Promise<EasyEmailContactResponse<TContact>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.contacts,
        body: contactRequest,
      });
    },
    getContact<TContact = EasyEmailContact>(
      contactId: string,
    ): Promise<EasyEmailContactResponse<TContact>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.contact(contactId) });
    },
    updateContact<TContact = EasyEmailContact>(
      contactId: string,
      contactRequest: EasyEmailContactUpdateRequest,
    ): Promise<EasyEmailContactResponse<TContact>> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.contact(contactId),
        body: contactRequest,
      });
    },
    deleteContact(contactId: string, expectedVersion: number): Promise<EasyEmailContactDeleteResponse> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.contact(contactId),
        query: { expectedVersion },
      });
    },
    listMailTaxonomy(
      query: EasyEmailMailTaxonomyListQuery,
    ): Promise<EasyEmailMailTaxonomyListResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.taxonomy, query });
    },
    getMailTaxonomy(itemId: string): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.taxonomyItem(itemId) });
    },
    upsertMailTaxonomy(
      kind: EasyEmailMailTaxonomyKind,
      key: string,
      taxonomyRequest: EasyEmailMailTaxonomyUpsertRequest,
    ): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return request({
        method: "PUT",
        path: EASY_EMAIL_CORE_ROUTES.taxonomyUpsert(kind, key),
        body: taxonomyRequest,
      });
    },
    updateMailTaxonomy(
      itemId: string,
      taxonomyRequest: EasyEmailMailTaxonomyUpdateRequest,
    ): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.taxonomyItem(itemId),
        body: taxonomyRequest,
      });
    },
    deleteMailTaxonomy(
      itemId: string,
      expectedVersion: number,
    ): Promise<EasyEmailMailTaxonomyDeleteResponse> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.taxonomyItem(itemId),
        query: { expectedVersion },
      });
    },
    listMailAccounts(query: EasyEmailMailAccountListQuery = {}): Promise<EasyEmailMailAccountsResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.accounts, query });
    },
    getMailAccount(accountId: string): Promise<EasyEmailMailAccountResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.account(accountId) });
    },
    createMailAccount(accountRequest: EasyEmailMailAccountCreateRequest): Promise<EasyEmailMailAccountResponse> {
      return request({ method: "POST", path: EASY_EMAIL_CORE_ROUTES.accounts, body: accountRequest });
    },
    updateMailAccount(accountId: string, accountRequest: EasyEmailMailAccountUpdateRequest): Promise<EasyEmailMailAccountResponse> {
      return request({ method: "PATCH", path: EASY_EMAIL_CORE_ROUTES.account(accountId), body: accountRequest });
    },
    disableMailAccount(accountId: string, expectedVersion: number): Promise<EasyEmailMailAccountResponse> {
      return request({ method: "POST", path: EASY_EMAIL_CORE_ROUTES.disableAccount(accountId), body: { expectedVersion } });
    },
    deleteMailAccount(accountId: string, expectedVersion: number): Promise<{ deleted: { id: string } }> {
      return request({ method: "DELETE", path: EASY_EMAIL_CORE_ROUTES.account(accountId), query: { expectedVersion } });
    },
    testMailAccountImap(
      testRequest: EasyEmailMailAccountImapTestRequest,
    ): Promise<EasyEmailMailAccountImapTestResponse> {
      return request({ method: "POST", path: EASY_EMAIL_CORE_ROUTES.testAccountImap, body: testRequest });
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
    refreshMailbox(sessionId: string): Promise<EasyEmailMailboxRefreshResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.refreshMailbox(sessionId),
      });
    },
    refreshAnonymousMailboxes(requestBody: {
      hostId: string;
    }): Promise<EasyEmailMailboxRefreshResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.refreshAnonymousMailboxes,
        body: requestBody,
      });
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
    releaseMailbox<TResult = EasyEmailReleaseMailboxResult>(
      releaseRequest: { sessionId: string; reason?: string },
    ): Promise<EasyEmailReleaseMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.releaseMailbox,
        body: releaseRequest,
      });
    },
    recoverMailbox<TResult = EasyEmailRecoverMailboxResult>(
      recoverRequest: EasyEmailRecoverMailboxRequest,
    ): Promise<EasyEmailRecoverMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.recoverMailbox,
        body: recoverRequest,
      });
    },
    reportMailboxOutcome<TResult = EasyEmailMailboxOutcomeResult>(
      outcomeRequest: EasyEmailMailboxOutcomeRequest,
    ): Promise<EasyEmailReportMailboxOutcomeResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.reportMailboxOutcome,
        body: outcomeRequest,
      });
    },
    sendMailboxMessage<TResult = EasyEmailMailboxSendResult>(
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
